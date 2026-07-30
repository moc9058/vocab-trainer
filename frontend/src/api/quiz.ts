import { ApiError, fetchJson, postJson, putJson } from "./client";
import type { QuizSession, QuizQuestion, Word } from "../types";

/**
 * `null` means "no session for this language" and NOTHING else. Every other failure is
 * rethrown: this used to swallow them all, so refreshing mid-quiz while offline was
 * indistinguishable from having no session and bounced the user to the home screen.
 */
export async function getCurrentSession(language: string): Promise<QuizSession | null> {
  try {
    return await fetchJson<QuizSession>(`/api/quiz/session/language/${encodeURIComponent(language)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function startQuiz(opts: {
  language: string;
  questionCount?: number;
  topics?: string[];
  categories?: string[];
  levels?: string[];
  groupIds?: string[];
  groupWeights?: Record<string, number>;
  correctWeight?: number;
  flaggedOnly?: boolean;
  questionType?: string;
}): Promise<QuizSession> {
  return postJson<QuizSession>("/api/quiz/start", opts);
}

/**
 * Hydrate questions BY ID. Session order changes constantly (retry re-queues, resume
 * reweighting, mid-session weight edits) but the set of ids never does, so the client caches
 * by id and re-orders for free. Shared by the word, Group A and Group B quizzes — the word
 * payload is identical for all three.
 */
export function hydrateQuizQuestions(
  language: string,
  wordIds: string[]
): Promise<{ questions: QuizQuestion[] }> {
  return postJson(`/api/quiz/hydrate/${encodeURIComponent(language)}`, { wordIds });
}

export function sampleWords(opts: {
  language: string;
  questionCount?: number;
  topics?: string[];
  categories?: string[];
  levels?: string[];
  groupIds?: string[];
  flaggedOnly?: boolean;
}): Promise<{ words: Word[] }> {
  return postJson<{ words: Word[] }>("/api/quiz/sample", opts);
}

// Mid-session weight change: server reorders the unanswered tail and returns
// the full session in the new order.
export function updateQuizWeights(
  language: string,
  groupWeights: Record<string, number>,
  correctWeight?: number
): Promise<QuizSession> {
  return putJson(
    `/api/quiz/session/language/${encodeURIComponent(language)}/weights`,
    { groupWeights, ...(correctWeight !== undefined ? { correctWeight } : {}) }
  );
}

export function answerQuestion(opts: {
  sessionId: string;
  wordId: string;
  correct: boolean;
  flagWordIds?: string[];
}): Promise<{ session: QuizSession }> {
  return postJson<{ session: QuizSession }>("/api/quiz/answer", opts);
}
