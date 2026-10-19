import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { applyReviewOperation, registerQuizReviewRoutes, assertLegacyReviewAllowed, type ReviewOperation } from "./quiz-review.js";
import type { QuizSession } from "./types.js";

const fixture = (): QuizSession => ({ sessionId: "chinese", language: "chinese", startedAt: "test",
  status: "in-progress", reviewedQuestionCount: 1, score: { correct: 1, total: 4 },
  questions: [{ wordId: "old", term: "old", definitions: [], userCorrect: true },
    { wordId: "a", term: "a", definitions: [], userCorrect: false },
    { wordId: "b", term: "b", definitions: [], userCorrect: true },
    { wordId: "c", term: "c", definitions: [] }] });
const start: ReviewOperation = { action: "start", startedAt: "test", reviewId: "review-1",
  revision: 0, fromAnsweredCount: 1, operationId: "start" };
const next = (revision: number): ReviewOperation => ({ ...start, action: "next", revision, operationId: `next-${revision}` });

test("review snapshots attempts, persists progress, and releases retries only at the end", () => {
  const original = fixture();
  const active = applyReviewOperation(original, start);
  assert.deepEqual(active.reviewState, { reviewId: "review-1", status: "active", fromAnsweredCount: 1,
    toAnsweredCount: 3, cursor: 0, revision: 0, lastOperationId: "start",
    questionOrder: active.reviewState!.questionOrder });
  assert.deepEqual([...active.reviewState!.questionOrder!].sort(), [0, 1]);
  const moved = applyReviewOperation(active, next(0));
  assert.equal(moved.reviewState!.cursor, 1);
  assert.equal(moved.reviewedQuestionCount, 1);
  assert.deepEqual(moved.questions, original.questions);
  assert.deepEqual(moved.score, original.score);
  assert.deepEqual(applyReviewOperation(moved, next(0)), moved);
  assert.deepEqual(applyReviewOperation(moved, start), moved);
  assert.throws(() => applyReviewOperation(moved, { ...next(0), operationId: "other-tab" }), /another screen/);
  const completed = applyReviewOperation(moved, next(1));
  assert.equal(completed.reviewState!.status, "completed");
  assert.equal(completed.reviewedQuestionCount, 3);
  assert.equal(completed.questions.filter(q => q.wordId === "a").length, 2);
  assert.deepEqual(applyReviewOperation(completed, next(1)), completed);
  // A late completion retry cannot consume answers from the next sitting.
  completed.questions[3].userCorrect = true;
  assert.equal(applyReviewOperation(completed, next(1)).reviewedQuestionCount, 3);
  assert.equal(assertLegacyReviewAllowed(completed), false);
  assert.throws(() => applyReviewOperation(completed, { ...start, reviewId: "old-boundary" }), /boundary/);
});

test("new reviews shuffle independently without reordering history or reshuffling a replay", t => {
  const random = t.mock.method(Math, "random", () => 0);
  const original = fixture();
  const active = applyReviewOperation(original, start);
  assert.deepEqual(active.reviewState!.questionOrder, [1, 0]);
  assert.deepEqual(active.questions, original.questions);
  const moved = applyReviewOperation(active, next(0));
  // Even if randomness changes, a saved review and a retried start retain the same order.
  random.mock.mockImplementation(() => 0.99);
  assert.deepEqual(applyReviewOperation(moved, start).reviewState!.questionOrder, [1, 0]);
  const completed = applyReviewOperation(moved, next(1));
  for (const question of completed.questions) if (question.userCorrect === undefined) question.userCorrect = true;
  const second = applyReviewOperation(completed, { ...start, reviewId: "review-2",
    operationId: "start-2", fromAnsweredCount: 3 });
  assert.deepEqual(second.reviewState!.questionOrder, [0, 1]);
  assert.deepEqual(second.questions, completed.questions);
});

test("completed quizzes stay completed and old/replaced reviews cannot mutate sessions", () => {
  const original = fixture();
  original.status = "completed"; original.questions.pop();
  let session = applyReviewOperation(original, start);
  assert.throws(() => assertLegacyReviewAllowed(session), /active review/);
  assert.throws(() => applyReviewOperation(session, { ...start, reviewId: "another" }), /already active/);
  assert.throws(() => applyReviewOperation(session, { ...next(0), startedAt: "replaced" }), /replaced/);
  session = applyReviewOperation(applyReviewOperation(session, next(0)), next(1));
  assert.equal(session.status, "completed");
  assert.equal(session.questions.length, 3);
  assert.throws(() => applyReviewOperation(session, { ...next(2), operationId: "extra" }), /another screen/);
  assert.throws(() => applyReviewOperation({ ...fixture(), reviewedQuestionCount: undefined },
    { ...start, fromAnsweredCount: 3 }), /No answers/);
});

test("review route validates input and keeps quiz namespaces separate", async () => {
  const app = Fastify(); await app.register(sensible);
  const stored = new Map<string, QuizSession>();
  for (const name of ["word", "grammar", "mixed", "importA", "importB", "recall"]) {
    stored.set(name, fixture());
    await app.register(async scope => registerQuizReviewRoutes<QuizSession>(scope, async (_language, fn) => {
      const session = structuredClone(stored.get(name)!);
      const result = await fn(session);
      stored.set(name, session);
      return result;
    }), { prefix: `/${name}` });
  }
  try {
    for (const name of stored.keys()) {
      const url = `/${name}/session/language/chinese/review`;
      assert.equal((await app.inject({ method: "PUT", url, payload: { ...start, revision: -1 } })).statusCode, 400);
      let response = await app.inject({ method: "PUT", url, payload: start });
      assert.equal(response.statusCode, 200, response.body);
      response = await app.inject({ method: "PUT", url, payload: next(0) });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().session.reviewState.cursor, 1);
      response = await app.inject({ method: "PUT", url, payload: { ...next(0), operationId: "stale" } });
      assert.equal(response.statusCode, 409, response.body);
    }
  } finally { await app.close(); }
});
