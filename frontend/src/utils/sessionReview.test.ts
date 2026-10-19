import { describe, expect, it } from "vitest";
import { hasPendingSessionReview, sessionReviewQuestions, unreviewedSessionQuestions } from "./sessionReview";
import type { QuizReviewState } from "../types";

const reviewState: QuizReviewState = { reviewId: "review", status: "active", cursor: 1,
  fromAnsweredCount: 1, toAnsweredCount: 3, revision: 1, lastOperationId: "next" };
const questions = [{ id: "old", userCorrect: true }, { id: "repeat", userCorrect: false },
  { id: "repeat", userCorrect: true }, { id: "pending" }];

describe("server-backed session reviews", () => {
  it("restores shuffled attempts by offset, including repeated IDs and the saved cursor", () => {
    const session = { questions, reviewedQuestionCount: 1,
      reviewState: { ...reviewState, questionOrder: [1, 0] } };
    expect(sessionReviewQuestions(session)).toEqual([questions[2], questions[1]]);
    expect(sessionReviewQuestions(session)[session.reviewState.cursor]).toEqual(questions[1]);
    expect(session.questions).toEqual(questions);
  });
  it("keeps repeated attempts and the fixed range across resume", () => {
    const session = { questions, reviewedQuestionCount: 1, reviewState };
    expect(sessionReviewQuestions(session)).toEqual(questions.slice(1, 3));
    expect(sessionReviewQuestions(session)[reviewState.cursor].userCorrect).toBe(true);
    expect(hasPendingSessionReview(session)).toBe(true);
  });
  it("does not resurrect legacy history without a boundary", () => {
    expect(unreviewedSessionQuestions(questions, undefined)).toEqual([]);
    expect(hasPendingSessionReview({ questions })).toBe(false);
  });
  it("keeps completed tests reachable only until their review is finished", () => {
    expect(hasPendingSessionReview({ questions, reviewedQuestionCount: 1 })).toBe(true);
    expect(hasPendingSessionReview({ questions, reviewedQuestionCount: 3,
      reviewState: { ...reviewState, status: "completed", cursor: 2 } })).toBe(false);
  });
  it("keeps the prior review score separate from new unreviewed attempts", () => {
    const session = { questions: [...questions, { id: "new", userCorrect: false }], reviewedQuestionCount: 3,
      reviewState: { ...reviewState, status: "completed" as const, cursor: 2 } };
    expect(sessionReviewQuestions(session)).toEqual(questions.slice(1, 3));
    expect(unreviewedSessionQuestions(session.questions, session.reviewedQuestionCount)).toEqual([{ id: "new", userCorrect: false }]);
  });
});
