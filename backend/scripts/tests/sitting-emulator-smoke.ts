/** Run only against a dedicated emulator; no production credentials or data are used. */
import assert from 'node:assert/strict';
import { Firestore } from '@google-cloud/firestore';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.FIRESTORE_PROJECT !== 'demo-quiz-sitting') {
  throw new Error('Requires FIRESTORE_EMULATOR_HOST and FIRESTORE_PROJECT=demo-quiz-sitting');
}
const db = new Firestore({ projectId: process.env.FIRESTORE_PROJECT, databaseId: process.env.FIRESTORE_DATABASE_ID });
const app = Fastify();
await app.register(sensible);
const { default: wordRoutes } = await import('../../src/routes/quiz.js');
const { default: grammarRoutes } = await import('../../src/routes/grammar-quiz.js');
const { default: recallRoutes } = await import('../../src/routes/expression-recall-quiz.js');
const { default: combinedRoutes, mixedQuizRoutes } = await import('../../src/routes/combined-quiz.js');
for (const [prefix, plugin] of [['word', wordRoutes], ['grammar', grammarRoutes], ['recall', recallRoutes], ['combined', combinedRoutes], ['mixed', mixedQuizRoutes]] as const) {
  await app.register(plugin, { prefix: `/${prefix}` });
}
const base = { language: 'chinese', startedAt: 'smoke', status: 'in-progress', reviewedQuestionCount: 0, score: { correct: 0, total: 2 } };
const wordQuestions = ['a', 'b'].map(wordId => ({ wordId, term: wordId, definitions: [] }));
const cases = [
  { route: 'word', collection: 'quiz_sessions', id: 'chinese', data: { ...base, wordIds: ['a', 'b'], questions: wordQuestions }, body: (id: string) => ({ sessionId: 'chinese', wordId: id }) },
  { route: 'grammar', collection: 'grammar_quiz_sessions', id: 'chinese', data: { ...base, questions: ['a', 'b'].map(grammarId => ({ grammarId, statement: grammarId })) }, body: (id: string) => ({ language: 'chinese', grammarId: id }) },
  { route: 'recall', collection: 'expression_recall_sessions', id: 'chinese', data: { ...base, direction: 'phrase-to-context', questions: ['a', 'b'].map(expressionId => ({ expressionId, prompt: expressionId })) }, body: (id: string) => ({ language: 'chinese', expressionId: id }) },
  ...['combined', 'mixed'].map(route => ({ route, collection: 'combined_quiz_sessions', id: route === 'mixed' ? 'chinese__mixed' : 'chinese', data: { ...base, initialTotal: 2, domainWeights: { word: 1, grammar: 1 }, wordGroupMembership: { home: ['a', 'b'] }, questions: wordQuestions.map(q => ({ ...q, kind: 'word' })) }, body: (id: string) => ({ language: 'chinese', kind: 'word', refId: id }) })),
];
try {
  await db.collection('languages').doc('chinese').set({ language: 'chinese' });
  await db.collection('word_groups').doc('home').set({ id: 'home', language: 'chinese', category: 'A', wordIds: ['a', 'b'], name: 'Smoke', createdAt: '2026-01-01' });
  for (const q of wordQuestions) await db.collection('words').doc(q.wordId).set({ ...q, id: q.wordId, language: 'chinese' });
  for (const c of cases) {
    const ref = db.collection(c.collection).doc(c.id);
    await ref.set(c.data);
    const answer = async (id: string, correct: boolean) => {
      const response = await app.inject({ method: 'POST', url: `/${c.route}/answer`, payload: { ...c.body(id), correct } });
      assert.equal(response.statusCode, 200, `${c.route}: ${response.body}`);
    };
    const review = async () => {
      const response = await app.inject({ method: 'PUT', url: `/${c.route}/session/language/chinese/reviewed`, payload: { startedAt: 'smoke' } });
      assert.equal(response.statusCode, 200, `${c.route}: ${response.body}`);
    };
    await answer('a', false);
    let saved = (await ref.get()).data()!;
    assert.equal(saved.questions.length, 2);
    const resumed = await app.inject(`/${c.route}/session/language/chinese`);
    assert.equal(resumed.statusCode, 200, resumed.body);
    saved = (await ref.get()).data()!;
    assert.equal(saved.questions.filter((q: any) => q.userCorrect === undefined).length, 1);
    await review(); await review();
    saved = (await ref.get()).data()!;
    assert.equal(saved.questions.length, 3);
    assert.equal(saved.reviewedQuestionCount, 1);
    await answer('a', false); await answer('b', true);
    saved = (await ref.get()).data()!;
    assert.equal(saved.status, 'completed');
    await review();
    saved = (await ref.get()).data()!;
    assert.equal(saved.status, 'completed');
    assert.equal(saved.questions.length, 3);
    console.log(`${c.route}: persisted Wrong, resume, mid-test review, replay, continuation, completion passed`);
  }
} finally {
  await app.close(); await db.terminate();
}
process.exit(0);
