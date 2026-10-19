import type { QuizReviewState } from "../types";

interface ReviewSession<Q> {
  questions: ReadonlyArray<Q>;
  reviewedQuestionCount?: number;
  reviewState?: QuizReviewState;
}

/** Legacy sessions without a boundary must not resurrect historical answers. */
export function unreviewedSessionQuestions<Q extends { userCorrect?: boolean }>(
  questions: ReadonlyArray<Q>, reviewedQuestionCount: number | undefined,
): Q[] {
  const answered = questions.filter(q => q.userCorrect !== undefined);
  const boundary = reviewedQuestionCount === undefined ? answered.length
    : Math.max(0, Math.min(reviewedQuestionCount, answered.length));
  return answered.slice(boundary);
}

/** Keep the fixed range even on the completion screen; it also supplies the review score. */
export function sessionReviewQuestions<Q extends { userCorrect?: boolean }>(session: ReviewSession<Q>): Q[] {
  const state = session.reviewState;
  if (state) {
    const questions = session.questions.filter(q => q.userCorrect !== undefined)
      .slice(state.fromAnsweredCount, state.toAnsweredCount);
    return state.questionOrder ? state.questionOrder.map(index => questions[index]) : questions;
  }
  return unreviewedSessionQuestions(session.questions, session.reviewedQuestionCount);
}

export function hasPendingSessionReview(session: ReviewSession<{ userCorrect?: boolean }>): boolean {
  return session.reviewState?.status === "active" ||
    unreviewedSessionQuestions(session.questions, session.reviewedQuestionCount).length > 0;
}
