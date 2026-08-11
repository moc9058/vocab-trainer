import { fetchJson, postJson, putJson, deleteJson, ApiError } from "./client";
import type { ExpressionQuizDirection, ExpressionRecallSession } from "../types";

const BASE = "/api/expression-recall-quiz";

export function startExpressionRecallQuiz(body: {
  language: string;
  direction?: ExpressionQuizDirection;
  questionCount?: number;
  purposeFilter?: ("speaking" | "writing")[];
  groupIds?: string[];
  groupWeights?: Record<string, number>;
}): Promise<ExpressionRecallSession> {
  return postJson(`${BASE}/start`, body);
}

export function answerExpressionRecallQuestion(body: {
  language: string;
  expressionId: string;
  correct: boolean;
}): Promise<{ session: ExpressionRecallSession }> {
  return postJson(`${BASE}/answer`, body);
}

/**
 * Null ONLY on 404. Everything else rethrows, so the caller can tell "no session
 * yet" from "you're offline" — the sibling `getCurrentExpressionSession` swallows
 * every error into `null`, which is exactly the bug the other quizzes fixed.
 */
export async function getCurrentExpressionRecallSession(
  language: string
): Promise<ExpressionRecallSession | null> {
  try {
    return await fetchJson(`${BASE}/session/language/${encodeURIComponent(language)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function deleteExpressionRecallSession(language: string): Promise<{ deleted: boolean }> {
  return deleteJson(`${BASE}/session/language/${encodeURIComponent(language)}`);
}

export function markExpressionRecallReviewComplete(
  language: string,
  startedAt: string
): Promise<{ reviewedQuestionCount: number }> {
  return putJson(`${BASE}/session/language/${encodeURIComponent(language)}/reviewed`, { startedAt });
}
