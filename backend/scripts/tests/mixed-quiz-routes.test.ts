// In-memory route regression: no credentials, network, or production Firestore access.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { CombinedQuizSession } from '../../src/types.js';

let stored: CombinedQuizSession | null = null;
let words = ['a', 'shared'];
let b = ['shared'];
let grammar = ['g'];
const saved = () => stored ? structuredClone(stored) : null;
const word = (id: string) => ({ id, term: id, definitions: [{ partOfSpeech: 'noun', text: { en: id } }] });
mock.module('../../src/firestore.js', { namedExports: {
  languageExists: async () => true,
  getWordGroups: async () => [{ id: 'a', wordIds: ['a', 'shared'], category: 'A' }, { id: 'b', wordIds: b, category: 'B' }],
  getGrammarGroups: async () => [{ id: 'bg', grammarIds: grammar, category: 'B' }],
  getWordsByIds: async (ids: string[]) => words.filter(id => ids.includes(id)).map(word),
  getGrammarItemsByIds: async (ids: string[]) => grammar.filter(id => ids.includes(id)).map(id => ({ id, statement: id })),
  getCombinedQuizSession: async () => saved(),
  saveCombinedQuizSession: async (s: CombinedQuizSession) => { stored = structuredClone(s); },
  getProgressForLanguage: async () => ({ words: {} }),
  getGrammarProgressForLanguage: async () => ({}),
  getWordProgress: async () => ({ timesSeen: 0, timesCorrect: 0, streak: 0 }),
  updateWordProgress: async () => {},
  getGrammarComponentProgress: async () => ({ timesSeen: 0, timesCorrect: 0, streak: 0 }),
  updateGrammarComponentProgress: async () => {},
  flagWord: async () => {},
  getFilteredWords: async () => { throw new Error('Mixed scope must not use client filters'); },
  getAllGrammarItems: async () => { throw new Error('Mixed scope must use group membership'); },
  getWordGroup: async () => null,
  getGrammarGroup: async () => null,
} });
const { mixedQuizRoutes } = await import('../../src/routes/combined-quiz.js');
const app = Fastify();
await app.register(sensible);
await app.register(mixedQuizRoutes, { prefix: '/api/mixed-quiz' });
const base = '/api/mixed-quiz';
const mixWeights = { category: { A: 1, B: 1 }, domain: { A: { word: 1, grammar: 1 }, B: { word: 1, grammar: 1 } }, groups: { word: { a: 1, b: 0 }, grammar: { bg: 0 } } };
const keys = (s: CombinedQuizSession) => s.questions.map(q => q.kind === 'word' ? q.wordId : q.grammarId);

test('start, answer, resume, weights and persisted legacy migration', async () => {
  const start = await app.inject({ method: 'POST', url: `${base}/start`, payload: { language: 'chinese', mixWeights, word: { groupIds: ['a'], wordIds: ['a'], flaggedOnly: true }, grammar: { groupIds: [] } } });
  assert.equal(start.statusCode, 201, start.body);
  assert.deepEqual(new Set(keys(start.json())), new Set(['a', 'shared', 'g']));
  assert.equal(start.json().questions.find((q: { kind: string }) => q.kind === 'word').definitions, undefined);
  const answer = await app.inject({ method: 'POST', url: `${base}/answer`, payload: { language: 'chinese', kind: 'word', refId: 'shared', correct: false } });
  assert.equal(answer.statusCode, 200, answer.body);
  words.push('new-b'); b = ['shared', 'new-b']; grammar.push('new-g');
  const resumed = await app.inject(`${base}/session/language/chinese`);
  assert.equal(resumed.statusCode, 200, resumed.body);
  const s: CombinedQuizSession = resumed.json();
  assert.equal(keys(s).filter(id => id === 'shared').length, 2);
  assert.ok(keys(s).includes('new-b')); assert.ok(keys(s).includes('new-g'));
  assert.equal(s.questions.find(q => q.kind === 'word' && q.wordId === 'shared')!.userCorrect, false);
  assert.equal(s.score.total, 6); assert.equal(s.initialTotal, 5);
  const weighted = await app.inject({ method: 'PUT', url: `${base}/session/language/chinese/weights`, payload: { mixWeights: { ...mixWeights, category: { A: 1, B: 3 } }, wordGroupWeights: { b: 0 }, grammarGroupWeights: { bg: 99 } } });
  assert.equal(weighted.statusCode, 200, weighted.body);
  assert.equal(weighted.json().mixWeights.groups.word.b, 1);
  // Simulate a session document written by the old release.
  delete stored!.mixedScope; delete stored!.mixWeights;
  const legacy = await app.inject(`${base}/session/language/chinese`);
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.equal(legacy.json().mixedScope.version, 1);
  assert.equal(keys(legacy.json()).filter(id => id === 'shared').length, 2);
  // Delete a B-only word and remove shared's B membership: its retry returns to A.
  b = []; words = ['a', 'shared']; grammar = [];
  const removed = await app.inject(`${base}/session/language/chinese`);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(new Set(keys(removed.json())), new Set(['a', 'shared']));
  assert.ok(removed.json().wordGroupMembership.a.includes('shared'));
  // Completed sessions remain historical, even if B later grows.
  stored!.status = 'completed'; words.push('later'); b = ['later'];
  const completed = await app.inject(`${base}/session/language/chinese`);
  assert.equal(completed.json().status, 'completed');
  assert.ok(!keys(completed.json()).includes('later'));
  await app.close();
});
