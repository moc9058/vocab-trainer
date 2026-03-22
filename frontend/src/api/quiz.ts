import { fetchJson, postJson } from "./client";
import type { QuizSession, QuizQuestion } from "../types";

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

export function answerQuestion(opts: {
  sessionId: string;
  wordId: string;
  correct: boolean;
}): Promise<{ session: QuizSession }> {
  return postJson<{ session: QuizSession }>("/api/quiz/answer", opts);
}
