import { describe, it, expect } from "vitest";
import { finishQuizSitting, normalizeQuizSitting } from "./quizSitting";
import { applyWordAnswerLocally, applyGrammarAnswerLocally, applyCombinedAnswerLocally, applyExpressionRecallAnswerLocally } from "./quizLocal";
import type { QuizSession, GrammarQuizSession, CombinedQuizSession, ExpressionRecallSession } from "../types";

describe("sitting boundaries across quiz types", () => {
  const base = { sessionId: "test", language: "chinese", startedAt: "start", status: "in-progress" as const, reviewedQuestionCount: 0, score: { correct: 0, total: 2 } };
  const cases = [
    { name: "word", session: { ...base, questions: ["a", "b"].map(wordId => ({ wordId, term: wordId, definitions: [] })) } as QuizSession,
      grade: (s: any, id: string, correct: boolean) => applyWordAnswerLocally(s, id, correct) },
    { name: "grammar", session: { ...base, questions: ["a", "b"].map(grammarId => ({ grammarId, statement: grammarId })) } as GrammarQuizSession,
      grade: (s: any, id: string, correct: boolean) => applyGrammarAnswerLocally(s, id, correct) },
    { name: "combined/article", session: { ...base, domainWeights: { word: 1, grammar: 1 }, initialTotal: 2, questions: ["a", "b"].map(wordId => ({ kind: "word" as const, wordId, term: wordId, definitions: [] })) } as CombinedQuizSession,
      grade: (s: any, id: string, correct: boolean) => applyCombinedAnswerLocally(s, "word", id, correct) },
    { name: "expression recall", session: { ...base, direction: "context-to-phrase", questions: ["a", "b"].map(expressionId => ({ expressionId, prompt: expressionId })) } as ExpressionRecallSession,
      grade: (s: any, id: string, correct: boolean) => applyExpressionRecallAnswerLocally(s, id, correct) },
  ];
  for (const { name, session, grade } of cases) {
    it(`${name}: Wrong waits for review completion, then is available once`, () => {
      const first = grade(session, "a", false);
      expect(first.questions).toHaveLength(2);
      expect(first.score).toEqual({ correct: 0, total: 2 });
      const next = finishQuizSitting(first);
      expect(next.questions).toHaveLength(3);
      expect(next.reviewedQuestionCount).toBe(1);
      expect(finishQuizSitting(next)).toEqual(next);
      const done = grade(grade(next, "a", false), "b", true);
      expect(done.status).toBe("completed");
      expect(finishQuizSitting(done).questions).toHaveLength(3);
      expect(done.score).toEqual({ correct: 1, total: 3 });
      expect(session.questions.every(q => q.userCorrect === undefined)).toBe(true);
    });
    it(`${name}: natural exhaustion completes even when every answer is Wrong`, () => {
      const done = grade(grade(session, "a", false), "b", false);
      expect(done.status).toBe("completed");
      expect(finishQuizSitting(done).questions.every(q => q.userCorrect === false)).toBe(true);
    });
  }
  it("removes legacy retries after the boundary, preserves older-sitting retries and domain identity", () => {
    const session = { ...base, reviewedQuestionCount: 1, questions: [
      { wordId: "old", userCorrect: false }, { wordId: "a", userCorrect: false },
      { wordId: "old" }, { wordId: "a" }, { grammarId: "a" }, { grammarId: "a" },
    ] };
    const result = normalizeQuizSitting(session);
    expect(result.questions).toEqual(session.questions.filter((_, i) => i !== 3 && i !== 5));
    expect(result.score.total).toBe(4);
    expect(result.reviewedQuestionCount).toBe(1);
  });
});
