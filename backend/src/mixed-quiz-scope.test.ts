import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeMixedScope, reconcileMixedScope } from './mixed-quiz-scope.js';
import type { CombinedQuizSession, WordGroup, GrammarGroup, Word, Grammar } from './types.js';
const wg = (id: string, wordIds: string[], category: 'A' | 'B' = 'A') => ({ id, name: id, wordIds, category } as WordGroup);
const gg = (id: string, grammarIds: string[], category: 'A' | 'B' = 'A') => ({ id, name: id, grammarIds, category } as GrammarGroup);
const word = (id: string) => ({ id, term: id, definitions: [] } as unknown as Word);
const grammar = (id: string) => ({ id, statement: id } as Grammar);
function session(): CombinedQuizSession {
  return { sessionId: 'chinese__mixed', language: 'chinese', startedAt: 'old-date', status: 'in-progress', score: { correct: 0, total: 0 }, initialTotal: 0, questions: [], domainWeights: { word: 1, grammar: 1 }, mixWeights: { category: { A: 2, B: 1 }, domain: { A: { word: 3, grammar: 1 }, B: { word: 1, grammar: 2 } } } };
}
const keys = (s: CombinedQuizSession) => s.questions.map(q => q.kind === 'word' ? q.wordId : q.grammarId);
test('all live B groups included without selection, B overlap wins, equal subgroup weights', () => {
  const s = session(); const groups = [wg('a', ['a', 'shared']), wg('b1', ['shared'], 'B'), wg('b2', ['b'], 'B')];
  s.mixWeights!.groups = { word: { b1: 99, b2: 0 }, grammar: {} };
  initializeMixedScope(s, groups, [], { word: ['a'] });
  reconcileMixedScope(s, groups, [], ['a', 'shared', 'b'].map(word), []);
  assert.deepEqual(new Set(keys(s)), new Set(['a', 'shared', 'b']));
  assert.deepEqual(s.wordGroupMembership, { b1: ['shared'], b2: ['b'], a: ['a'] });
  assert.equal(s.wordGroupWeights!.b1, s.wordGroupWeights!.b2);
  assert.equal(s.mixWeights!.groups!.word.b1, 1);
});
test('resume adds new words and grammar, preserves history, retry and review cursor; idempotent', () => {
  const s = session(); const groups = [wg('a', ['done', 'retry']), wg('b', ['done', 'retry'], 'B')];
  initializeMixedScope(s, groups, [], { word: ['a'] });
  reconcileMixedScope(s, groups, [], ['done', 'retry'].map(word), []);
  s.questions[0].userCorrect = true;
  s.questions[1].userCorrect = false;
  s.questions.push({ kind: 'word', wordId: 'retry', term: 'retry', definitions: [] });
  s.score.correct = 1; s.reviewedQuestionCount = 1;
  const history = s.questions.slice(0, 2);
  const changed = [...groups, wg('new-b', ['new', 'retry'], 'B')]; const grammarGroups = [gg('bg', ['new-g'], 'B')];
  for (let i = 0; i < 2; i++) reconcileMixedScope(s, changed, grammarGroups, ['done', 'retry', 'new'].map(word), [grammar('new-g')]);
  assert.deepEqual(s.questions.slice(0, 2), history);
  assert.deepEqual(keys(s), ['done', 'retry', 'retry', 'new', 'new-g']);
  assert.equal(s.initialTotal, 4); assert.equal(s.score.total, 5); assert.equal(s.score.correct, 1);
  assert.equal(s.reviewedQuestionCount, 1); assert.equal(s.startedAt, 'old-date');
});
test('B removal restores selected A membership; B-only removal and deleted documents leave pending pool', () => {
  const s = session(); const groups = [wg('a', ['shared']), wg('b', ['shared', 'b-only', 'deleted', 'answered'], 'B')];
  initializeMixedScope(s, groups, [], { word: ['a'] });
  reconcileMixedScope(s, groups, [], ['shared', 'b-only', 'deleted', 'answered'].map(word), []);
  s.questions.find(q => q.kind === 'word' && q.wordId === 'answered')!.userCorrect = true;
  s.score.correct = 1;
  reconcileMixedScope(s, [groups[0], wg('b', ['deleted'], 'B')], [], ['shared', 'b-only'].map(word), []);
  assert.deepEqual(keys(s), ['shared', 'answered']);
  assert.deepEqual(s.wordGroupMembership!.a, ['shared']);
  assert.equal(s.initialTotal, 2); assert.equal(s.score.total, 2); assert.equal(s.score.correct, 1);
});
test('legacy cloud session migrates once, keeps its A scope and adds every current B group', () => {
  const s = session(); delete s.mixWeights;
  s.questions = [{ kind: 'word', wordId: 'a', term: 'a', definitions: [] }, { kind: 'word', wordId: 'old-b', term: 'old-b', definitions: [] }];
  s.wordGroupMembership = { selectedA: ['a'], oldB: ['old-b'] };
  s.wordGroupWeights = { selectedA: 4, oldB: 2 };
  const groups = [wg('selectedA', ['a', 'old-b', 'unrelated-new-a']), wg('unselectedA', ['excluded']), wg('oldB', ['old-b'], 'B'), wg('newB', ['new-b'], 'B')];
  initializeMixedScope(s, groups, []);
  assert.deepEqual(s.mixedScope!.wordA, { selectedA: ['a', 'old-b'] });
  const saved = structuredClone(s.mixedScope);
  reconcileMixedScope(s, groups, [], ['a', 'old-b', 'new-b', 'excluded', 'unrelated-new-a'].map(word), []);
  initializeMixedScope(s, [], []);
  assert.deepEqual(s.mixedScope!.wordA, saved!.wordA);
  assert.deepEqual(s.mixedScope!.grammarA, saved!.grammarA);
  assert.deepEqual(s.mixedScope!.wordB, { oldB: ["old-b"], newB: ["new-b"] });
  assert.deepEqual(new Set(keys(s)), new Set(['a', 'old-b', 'new-b']));
  assert.equal(s.mixWeights!.category.A / s.mixWeights!.category.B, 2);
});
test('mastered newcomers classified without resetting wrong-answer retries to mastered', () => {
  const s = session(); s.correctWeight = 2;
  const groups = [wg('b', ['retry'], 'B')];
  initializeMixedScope(s, groups, [], { word: [] });
  reconcileMixedScope(s, groups, [], [word('retry')], []);
  s.questions[0].userCorrect = false;
  s.questions.push({ kind: 'word', wordId: 'retry', term: 'retry', definitions: [] });
  reconcileMixedScope(s, [wg('b', ['retry', 'known'], 'B')], [], ['retry', 'known'].map(word), [], { wordIds: ['retry', 'known'], grammarIds: [] });
  assert.deepEqual(s.correctMembership!.wordIds, ['known']);
});
test('empty B can gain a newly created group later; A additions do not expand the snapshot', () => {
  const s = session(); const a = wg('a', ['a']);
  initializeMixedScope(s, [a], [], { word: ['a'] });
  reconcileMixedScope(s, [a], [], [word('a')], []);
  reconcileMixedScope(s, [wg('a', ['a', 'new-a']), wg('brand-new', ['new-b'], 'B')], [], ['a', 'new-a', 'new-b'].map(word), []);
  assert.deepEqual(keys(s), ['a', 'new-b']);
});
test('category and domain ratios remain stable when number of B groups changes', () => {
  const s = session(); const a = wg('a', ['a']); const ag = gg('ag', ['ag']);
  initializeMixedScope(s, [a], [ag], { word: ['a'], grammar: ['ag'] });
  reconcileMixedScope(s, [a, wg('b1', ['b1'], 'B'), wg('b2', ['b2'], 'B')], [ag, gg('bg', ['bg'], 'B')], ['a', 'b1', 'b2'].map(word), ['ag', 'bg'].map(grammar));
  const w = s.wordGroupWeights!, g = s.grammarGroupWeights!;
  const sumW = Object.values(w).reduce((a,b) => a+b, 0), sumG = Object.values(g).reduce((a,b) => a+b, 0);
  const aw = s.domainWeights.word * w.a / sumW, bw = s.domainWeights.word * (w.b1+w.b2) / sumW;
  const agm = s.domainWeights.grammar * g.ag / sumG, bgm = s.domainWeights.grammar * g.bg / sumG;
  assert.ok(Math.abs((aw+agm)/(bw+bgm) - 2) < 1e-9);
  assert.ok(Math.abs(aw/agm - 3) < 1e-9);
  assert.ok(Math.abs(bw/bgm - 0.5) < 1e-9);
});
test('removing all pending B items finishes while retaining answered history', () => {
  const s = session(); const groups = [wg('b', ['done', 'pending'], 'B')];
  initializeMixedScope(s, groups, [], { word: [] });
  reconcileMixedScope(s, groups, [], ['done', 'pending'].map(word), []);
  s.questions[0].userCorrect = true; s.score.correct = 1;
  reconcileMixedScope(s, [], [], [], []);
  assert.equal(s.status, 'completed'); assert.deepEqual(keys(s), ['done']);
});
test('zero-weight new buckets are excluded until enabled; B subgroup zero is ignored', () => {
  const s = session(); s.mixWeights!.category.B = 0;
  const groups = [wg('a', ['a']), wg('b', ['b'], 'B')];
  initializeMixedScope(s, groups, [], { word: ['a'] });
  reconcileMixedScope(s, groups, [], ['a', 'b'].map(word), []);
  assert.deepEqual(keys(s), ['a']);
  s.mixWeights!.category.B = 1;
  s.mixWeights!.groups!.word.b = 0;
  reconcileMixedScope(s, groups, [], ['a', 'b'].map(word), []);
  assert.deepEqual(keys(s), ['a', 'b']);
});
test('legacy ungrouped sessions preserve their original A pool', () => {
  const s = session();
  s.questions = [{ kind: 'word', wordId: 'a', term: 'a', definitions: [] }];
  const groups = [wg('a-home', ['a', 'later-a']), wg('b', ['b'], 'B')];
  initializeMixedScope(s, groups, []);
  reconcileMixedScope(s, groups, [], ['a', 'later-a', 'b'].map(word), []);
  assert.deepEqual(keys(s), ['a', 'b']);
});
