import { describe, it, expect, vi } from "vitest";
import { applyMixedOperation, orderMixedQuestions } from "./mixedOperations";
import { mixedCategoryProgress } from "./mixedProgress";
import type { CombinedQuizSession } from "../types";

const fixture = (): CombinedQuizSession => ({
  sessionId: "chinese__mixed", language: "chinese", startedAt: "start", status: "in-progress",
  score: { correct: 0, total: 3 }, initialTotal: 3, domainWeights: { word: 1, grammar: 1 },
  questions: [{ kind: "word", wordId: "b", term: "B", definitions: [] }, { kind: "word", wordId: "a", term: "A", definitions: [] }, { kind: "grammar", grammarId: "g", statement: "G" }],
  wordGroupMembership: { a: ["a"], b: ["b"] }, grammarGroupMembership: { bg: ["g"] },
  mixedScope: { version: 1, wordA: { a: ["a"] }, grammarA: {}, wordB: { b: ["b"] }, grammarB: { bg: ["g"] } },
  mixWeights: { category: { A: 1, B: 1 }, domain: { A: { word: 1, grammar: 1 }, B: { word: 1, grammar: 1 } } },
});
describe("mixed local state", () => {
  it("uses the server-provided A home even before group metadata loads", () => {
    const s = fixture(); s.mixedScope!.wordAHomes = { b: "outside" };
    const next = applyMixedOperation(s, { kind: "word", refId: "b", correct: false, removeFromGroupB: true });
    expect(next.mixedScope?.retainedWordA).toEqual({ outside: ["b"] });
  });
  it("A includes B, retries count once, removal changes B only", () => {
    const s = fixture(); s.questions.push({ ...s.questions[0], userCorrect: false });
    expect(mixedCategoryProgress(s)[0].cells[0]).toEqual({ kind: "word", total: 2, remaining: 2 });
    expect(mixedCategoryProgress(s)[1].cells[0].total).toBe(1);
    const next = applyMixedOperation(s, { kind: "word", refId: "b", correct: false, removeFromGroupB: true }, "outside");
    expect(mixedCategoryProgress(next)[0].cells[0]).toEqual({ kind: "word", total: 2, remaining: 2 });
    expect(mixedCategoryProgress(next)[1].cells[0]).toEqual({ kind: "word", total: 0, remaining: 0 });
    expect(next.mixedScope?.retainedWordA).toEqual({ outside: ["b"] });
    expect(s.mixedScope?.wordB).toEqual({ b: ["b"] });
  });
  it("grammar removal + Correct preserves history but no pending copy", () => {
    const next = applyMixedOperation(fixture(), { kind: "grammar", refId: "g", correct: true, removeFromGroupB: true });
    expect(next.questions.filter(q => q.kind === "grammar" && q.userCorrect === undefined)).toHaveLength(0);
    expect(mixedCategoryProgress(next)[0].cells[1]).toEqual({ kind: "grammar", total: 1, remaining: 0 });
    expect(mixedCategoryProgress(next)[1].cells[1].total).toBe(0);
  });
  it("reorder pins the visible card, keeps review boundary and deduplicates pending IDs", () => {
    const s = fixture(); s.reviewedQuestionCount = 0; s.questions.push({ ...s.questions[0] });
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    const next = orderMixedQuestions(s, true);
    expect(next.questions[0]).toEqual(s.questions[0]);
    expect(next.questions).toHaveLength(3);
    expect(next.reviewedQuestionCount).toBe(0);
    vi.restoreAllMocks();
  });
});
