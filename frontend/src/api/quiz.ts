import { fetchJson, postJson } from "./client";
import type { QuizSession, QuizSessionSummary } from "../types";

export function getHistory(language?: string): Promise<QuizSessionSummary[]> {
  const params = language ? `?language=${encodeURIComponent(language)}` : "";
  return fetchJson<QuizSessionSummary[]>(`/api/quiz/history${params}`);
}

export function getSessionDetails(sessionId: string): Promise<QuizSession> {
  return fetchJson<QuizSession>(`/api/quiz/history/${sessionId}`);
}

export function startQuiz(opts: {
  language: string;
  questionCount?: number;
  topics?: string[];
  categories?: string[];
  questionType?: string;
}): Promise<QuizSession> {
  return postJson<QuizSession>("/api/quiz/start", opts);
}

export function answerQuestion(opts: {
  sessionId: string;
  wordId: string;
  correct: boolean;
}): Promise<{ session: QuizSession }> {
  return postJson<{ session: QuizSession }>("/api/quiz/answer", opts);
}
