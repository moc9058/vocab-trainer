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
const { default: combinedRoutes, mixedQuizRoutes, importQuizARoutes, importQuizBRoutes } = await import('../../src/routes/combined-quiz.js');
for (const [prefix, plugin] of [['word', wordRoutes], ['grammar', grammarRoutes], ['recall', recallRoutes], ['combined', combinedRoutes], ['mixed', mixedQuizRoutes], ['importA', importQuizARoutes], ['importB', importQuizBRoutes]] as const) {
  await app.register(plugin, { prefix: `/${prefix}` });
}
const base = { language: 'chinese', startedAt: 'smoke', status: 'in-progress', reviewedQuestionCount: 0, score: { correct: 0, total: 2 } };
const wordQuestions = ['a', 'b'].map(wordId => ({ wordId, term: wordId, definitions: [] }));
const cases = [
  { route: 'word', collection: 'quiz_sessions', id: 'chinese', data: { ...base, wordIds: ['a', 'b'], questions: wordQuestions }, body: (id: string) => ({ sessionId: 'chinese', wordId: id }) },
  { route: 'grammar', collection: 'grammar_quiz_sessions', id: 'chinese', data: { ...base, questions: ['a', 'b'].map(grammarId => ({ grammarId, statement: grammarId })) }, body: (id: string) => ({ language: 'chinese', grammarId: id }) },
  { route: 'recall', collection: 'expression_recall_sessions', id: 'chinese', data: { ...base, direction: 'phrase-to-context', questions: ['a', 'b'].map(expressionId => ({ expressionId, prompt: expressionId })) }, body: (id: string) => ({ language: 'chinese', expressionId: id }) },
  ...['combined', 'mixed', 'importA', 'importB'].map(route => ({ route, collection: 'combined_quiz_sessions', id: route === 'combined' ? 'chinese' : `chinese__${route}`, data: { ...base, initialTotal: 2, domainWeights: { word: 1, grammar: 1 }, wordGroupMembership: { home: ['a', 'b'] }, questions: wordQuestions.map(q => ({ ...q, kind: 'word' })) }, body: (id: string) => ({ language: 'chinese', kind: 'word', refId: id }) })),
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
    // The standard quiz routes used to perform independent read/modify/write cycles here.
    // A resume that read before the answer and saved afterward could restore `a` as pending.
    if (c.route === 'word' || c.route === 'grammar' || c.route === 'recall') {
      const [answerResponse, resumeResponse] = await Promise.all([
        app.inject({ method: 'POST', url: `/${c.route}/answer`, payload: { ...c.body('a'), correct: false } }),
        app.inject(`/${c.route}/session/language/chinese`),
      ]);
      assert.equal(answerResponse.statusCode, 200, `${c.route}: ${answerResponse.body}`);
      assert.equal(resumeResponse.statusCode, 200, `${c.route}: ${resumeResponse.body}`);
      const raced = (await ref.get()).data()!;
      const a = raced.questions.find((q: any) => (q.wordId ?? q.grammarId ?? q.expressionId) === 'a');
      assert.equal(a.userCorrect, false, `${c.route}: concurrent resume restored Wrong as pending`);
      await ref.set(c.data);
    }
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
    // New review protocol: three answered attempts, one pending; the same ID can recur.
    const sample = c.data.questions[0];
    await ref.set({ ...c.data, score: { correct: 2, total: 4 }, questions: [
      { ...sample, userCorrect: false }, { ...sample, userCorrect: true },
      { ...sample, userCorrect: true }, c.data.questions[1],
    ] });
    const reviewUrl = `/${c.route}/session/language/chinese/review`;
    const startInput = { action: 'start', startedAt: 'smoke', reviewId: `review-${c.route}`,
      operationId: 'start', revision: 0, fromAnsweredCount: 0 };
    let response = await app.inject({ method: 'PUT', url: reviewUrl, payload: startInput });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().session.reviewState.toAnsweredCount, 3);
    const blockedAnswer = await app.inject({ method: 'POST', url: `/${c.route}/answer`,
      payload: { ...c.body('b'), correct: true, ...(c.route === 'mixed' ? { startedAt: 'smoke', operationId: 'blocked-grade' } : {}) } });
    assert.equal(blockedAnswer.statusCode, 409, blockedAnswer.body);
    const blockedLegacy = await app.inject({ method: 'PUT', url: `/${c.route}/session/language/chinese/reviewed`, payload: { startedAt: 'smoke' } });
    assert.equal(blockedLegacy.statusCode, 409, blockedLegacy.body);
    const firstNext = { ...startInput, action: 'next', operationId: 'next-0' };
    // A duplicate transaction must not advance twice, even under concurrency.
    const concurrent = await Promise.all([0, 1].map(() => app.inject({ method: 'PUT', url: reviewUrl, payload: firstNext })));
    for (const r of concurrent) assert.equal(r.statusCode, 200, r.body);
    const reloaded = await app.inject(`/${c.route}/session/language/chinese`);
    assert.equal(reloaded.statusCode, 200, reloaded.body);
    assert.equal(reloaded.json().reviewState.cursor, 1);
    assert.equal(reloaded.json().reviewedQuestionCount, 0);
    assert.equal((await ref.get()).data()!.reviewState.cursor, 1);
    // Explicit read helpers must include the new state too (not only transactional reads).
    const store = await import('../../src/firestore.js');
    const mapped = c.route === 'word' ? await store.getQuizSession(c.id)
      : c.route === 'grammar' ? await store.getGrammarQuizSession(c.id)
      : c.route === 'recall' ? await store.getExpressionRecallSession(c.id)
      : await store.getCombinedQuizSession(c.id);
    assert.equal(mapped!.reviewState!.cursor, 1);
    for (const revision of [1, 2]) {
      response = await app.inject({ method: 'PUT', url: reviewUrl,
        payload: { ...firstNext, revision, operationId: `next-${revision}` } });
      assert.equal(response.statusCode, 200, response.body);
    }
    const finalReplay = await app.inject({ method: 'PUT', url: reviewUrl,
      payload: { ...firstNext, revision: 2, operationId: 'next-2' } });
    assert.equal(finalReplay.statusCode, 200, finalReplay.body);
    assert.equal(finalReplay.json().session.reviewState.status, 'completed');
    assert.equal(finalReplay.json().session.reviewedQuestionCount, 3);
    // Latest attempt was Correct, so no retry is released for that item.
    assert.equal(finalReplay.json().session.questions.length, 4);
    console.log(`${c.route}: persisted answers, resume, review progress, concurrent replay, mappings and completion passed`);
  }
} finally {
  await app.close(); await db.terminate();
}
process.exit(0);
