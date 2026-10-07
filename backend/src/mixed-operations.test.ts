import { finishQuizSitting } from "./quiz-sitting.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { applyMixedOperation, orderMixedQuestions, recalculateMixedWeights } from "./mixed-operations.js";
import { reconcileMixedScope } from "./mixed-quiz-scope.js";
import type { CombinedQuizSession, Word, WordGroup } from "./types.js";

function fixture(): CombinedQuizSession {
  return {
    sessionId: "chinese__mixed", language: "chinese", startedAt: "start", status: "in-progress", reviewedQuestionCount: 0,
    questions: ["b", "a", "a2"].map(wordId => ({ kind: "word", wordId, term: wordId, definitions: [] })),
    score: { correct: 0, total: 3 }, initialTotal: 3, domainWeights: { word: 2, grammar: 0 },
    wordGroupMembership: { a: ["a", "a2"], b: ["b"] }, grammarGroupMembership: {},
    wordGroupWeights: { a: 1, b: 3 },
    mixedScope: { version: 1, wordA: { a: ["a", "a2"] }, grammarA: {}, wordB: { b: ["b"] }, grammarB: {} },
    mixWeights: { category: { A: 1, B: 3 }, domain: { A: { word: 1, grammar: 0 }, B: { word: 1, grammar: 0 } }, groups: { word: { a: 1 }, grammar: {} } },
  };
}
const pending = (s: CombinedQuizSession) => s.questions.filter(q => q.userCorrect === undefined).map(q => q.kind === "word" ? q.wordId : q.grammarId);

test("B removal + Wrong retains an unselected A home across reconciliation and weight changes", () => {
  let s = applyMixedOperation(fixture(), { kind: "word", refId: "b", correct: false, removeFromGroupB: true }, "outside");
  assert.deepEqual(s.mixedScope!.wordA, { a: ["a", "a2"] });
  assert.deepEqual(s.mixedScope!.retainedWordA, { outside: ["b"] });
  assert.deepEqual(s.mixedScope!.wordB, { b: [] });
  s.mixWeights!.category.A = 4;
  const groups = [{ id: "a", wordIds: ["a", "a2"], category: "A" }, { id: "outside", wordIds: ["b"], category: "A" }, { id: "b", wordIds: [], category: "B" }] as WordGroup[];
  reconcileMixedScope(s, groups, [], ["a", "a2", "b"].map(id => ({ id, term: id, definitions: [] })) as Word[], []);
  assert.equal(pending(s).filter(id => id === "b").length, 0);
  s = finishQuizSitting(s);
  assert.equal(pending(s).filter(id => id === "b").length, 1);
  assert.ok(s.wordGroupMembership!.outside.includes("b"));
  assert.equal(s.questions.find(q => q.userCorrect === false)?.kind, "word");
});

test("removal + Correct removes all pending copies, keeps history, and never readmits on resume", () => {
  const initial = fixture();
  initial.questions.push({ ...initial.questions[0] });
  const s = applyMixedOperation(initial, { kind: "word", refId: "b", correct: true, removeFromGroupB: true });
  assert.ok(!pending(s).includes("b"));
  assert.equal(s.questions.filter(q => q.kind === "word" && q.wordId === "b").length, 1);
  reconcileMixedScope(s, [], [], ["a", "a2", "b"].map(id => ({ id, term: id })) as Word[], []);
  assert.ok(!pending(s).includes("b"));
  assert.equal(s.score.correct, 1);
});

test("removal without grading retains a pinned pending item and does not change score", () => {
  const s = applyMixedOperation(fixture(), { kind: "word", refId: "b", removeFromGroupB: true });
  assert.equal(pending(s)[0], "b");
  assert.equal(s.score.correct, 0);
  assert.equal(s.score.total, 3);
});

test("Wrong cannot repeat in the sitting; the last Wrong completes the quiz", () => {
  let s = fixture();
  s = applyMixedOperation(s, { kind: "word", refId: "b", correct: false });
  assert.ok(!pending(s).includes("b"));
  assert.throws(() => applyMixedOperation(s, { kind: "word", refId: "b", correct: false }), /not pending/);
  s = finishQuizSitting(s);
  assert.equal(pending(s).filter(id => id === "b").length, 1);
  s = applyMixedOperation(s, { kind: "word", refId: "a", correct: true });
  s = applyMixedOperation(s, { kind: "word", refId: "a2", correct: true });
  s = applyMixedOperation(s, { kind: "word", refId: "b", correct: false });
  assert.equal(s.status, "completed");
  assert.deepEqual(pending(finishQuizSitting(s)), []);
});

test("zero-weight pending retries survive, and wrong leaves the already-correct bucket", () => {
  const s = fixture(); s.correctWeight = 0; s.correctMembership = { wordIds: ["b"], grammarIds: [] };
  s.mixWeights!.category.A = 0;
  const next = applyMixedOperation(s, { kind: "word", refId: "b", correct: false, removeFromGroupB: true });
  assert.ok(!pending(next).includes("b"));
  assert.ok(pending(finishQuizSitting(next)).includes("b"));
  assert.deepEqual(next.correctMembership!.wordIds, []);
});

test("seeded draws respect weights, equal item chances, and ignore previous Wrong count", () => {
  let seed = 7123;
  const rng = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  mock.method(Math, "random", rng);
  try {
    const s = fixture(); recalculateMixedWeights(s);
    const counts = { a: 0, a2: 0, b: 0 };
    for (let i = 0; i < 12000; i++) counts[pending(orderMixedQuestions(s))[0] as keyof typeof counts]++;
    assert.ok(counts.b > 8700 && counts.b < 9300, JSON.stringify(counts));
    assert.ok(Math.abs(counts.a - counts.a2) < 200, JSON.stringify(counts));
    const wrong = fixture();
    wrong.questions.unshift(...Array.from({ length: 20 }, () => ({ ...wrong.questions[0], userCorrect: false })));
    seed = 923;
    const first = pending(orderMixedQuestions(s));
    seed = 923;
    recalculateMixedWeights(wrong);
    assert.deepEqual(pending(orderMixedQuestions(wrong)), first);
  } finally { mock.restoreAll(); }
});

test("backend and frontend use identical mixed transition rules", async () => {
  const { readFile } = await import("node:fs/promises");
  const backend = await readFile(new URL("./mixed-operations.ts", import.meta.url), "utf8");
  const frontend = await readFile(new URL("../../frontend/src/utils/mixedOperations.ts", import.meta.url), "utf8");
  assert.equal(backend.slice(backend.indexOf("export interface MixedOperation")), frontend.slice(frontend.indexOf("export interface MixedOperation")));
});
