import { fetchJson, postJson, putJson } from "./client";
import type { QuizSession, QuizQuestion, Word } from "../types";

export async function getCurrentSession(language: string): Promise<QuizSession | null> {
  try {
    return await fetchJson<QuizSession>(`/api/quiz/session/language/${encodeURIComponent(language)}`);
  } catch {
    return null;
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

export function getQuizQuestions(
  language: string,
  offset: number,
  limit: number
): Promise<{ questions: QuizQuestion[]; total: number }> {
  return fetchJson(`/api/quiz/questions/${encodeURIComponent(language)}?offset=${offset}&limit=${limit}`);
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
