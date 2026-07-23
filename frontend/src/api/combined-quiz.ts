import { fetchJson, postJson, putJson } from "./client";
import type { CombinedQuizQuestion, CombinedQuizSession } from "../types";

export async function getCurrentCombinedSession(
  language: string
): Promise<CombinedQuizSession | null> {
  try {
    return await fetchJson<CombinedQuizSession>(
      `/api/combined-quiz/session/language/${encodeURIComponent(language)}`
    );
  } catch {
    return null;
  }
}

export function startCombinedQuiz(opts: {
  language: string;
  domainWeights: { word: number; grammar: number };
  correctWeight?: number;
  word?: {
    topics?: string[];
    categories?: string[];
    levels?: string[];
    groupIds?: string[];
    groupWeights?: Record<string, number>;
    flaggedOnly?: boolean;
  };
  grammar?: {
    groupIds?: string[];
    groupWeights?: Record<string, number>;
  };
}): Promise<CombinedQuizSession> {
  return postJson<CombinedQuizSession>("/api/combined-quiz/start", opts);
}

export function getCombinedQuizQuestions(
  language: string,
  offset: number,
  limit: number
): Promise<{ questions: CombinedQuizQuestion[]; total: number }> {
  return fetchJson(
    `/api/combined-quiz/questions/${encodeURIComponent(language)}?offset=${offset}&limit=${limit}`
  );
}

// Mid-session weight change: server reorders the unanswered tail and returns
// the full session in the new order.
export function updateCombinedQuizWeights(
  language: string,
  weights: {
    domainWeights?: { word: number; grammar: number };
    wordGroupWeights?: Record<string, number>;
    grammarGroupWeights?: Record<string, number>;
    correctWeight?: number;
  }
): Promise<CombinedQuizSession> {
  return putJson(
    `/api/combined-quiz/session/language/${encodeURIComponent(language)}/weights`,
    weights
  );
}

export function answerCombinedQuestion(opts: {
  language: string;
  kind: "word" | "grammar";
  refId: string;
  correct: boolean;
  flagWordIds?: string[];
}): Promise<{ session: CombinedQuizSession }> {
  return postJson<{ session: CombinedQuizSession }>("/api/combined-quiz/answer", opts);
}
