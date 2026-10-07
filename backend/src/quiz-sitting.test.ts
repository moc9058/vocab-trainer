import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { finishQuizSitting, normalizeQuizSitting } from './quiz-sitting.js';

test('legacy sitting acquires a durable boundary before any new answer', () => {
  const original = { questions: [{ wordId: 'old', userCorrect: false }, { wordId: 'old' }, { wordId: 'new' }, { wordId: 'last' }], status: 'in-progress', score: { correct: 0, total: 4 } };
  const session = normalizeQuizSitting(original);
  assert.equal((session as typeof session & { reviewedQuestionCount: number }).reviewedQuestionCount, 1);
  assert.deepEqual(session.questions.map(q => q.wordId), ['old', 'new', 'last']);
  session.questions[1] = { ...session.questions[1], userCorrect: false };
  const next = finishQuizSitting(session);
  assert.deepEqual(next.questions.filter(q => q.userCorrect === undefined).map(q => q.wordId), ['last', 'new']);
});

test('review does not resurrect a mixed item removed from its effective scope', () => {
  const session = { questions: [{ wordId: 'gone', userCorrect: false }, { wordId: 'pending' }], reviewedQuestionCount: 0, status: 'in-progress', score: { correct: 0, total: 2 }, mixedScope: {}, wordGroupMembership: { a: ['pending'] } };
  const next = finishQuizSitting(session);
  assert.deepEqual(next.questions, session.questions);
  assert.equal(next.reviewedQuestionCount, 1);
});

test('server and client use identical sitting transition rules', async () => {
  const server = await readFile(new URL('./quiz-sitting.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../../frontend/src/utils/quizSitting.ts', import.meta.url), 'utf8');
  assert.equal(server, client);
});
