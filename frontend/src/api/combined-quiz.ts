import { fetchJson, postJson, putJson } from "./client";
import type { CombinedQuizQuestion, CombinedQuizSession } from "../types";

/** Which of the two identical route trees to talk to. "groupB" drills only the
 *  category-B groups and keeps its own session per language. */
export type CombinedQuizVariant = "combined" | "groupB";

function base(variant: CombinedQuizVariant = "combined"): string {
  return variant === "groupB" ? "/api/group-b-quiz" : "/api/combined-quiz";
}

export async function getCurrentCombinedSession(
  language: string,
  variant: CombinedQuizVariant = "combined"
): Promise<CombinedQuizSession | null> {
  try {
    return await fetchJson<CombinedQuizSession>(
      `${base(variant)}/session/language/${encodeURIComponent(language)}`
    );
  } catch {
    return null;
  }
}

export function startCombinedQuiz(
  opts: {
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
  },
  variant: CombinedQuizVariant = "combined"
): Promise<CombinedQuizSession> {
  return postJson<CombinedQuizSession>(`${base(variant)}/start`, opts);
}

export function getCombinedQuizQuestions(
  language: string,
  offset: number,
  limit: number,
  variant: CombinedQuizVariant = "combined"
): Promise<{ questions: CombinedQuizQuestion[]; total: number }> {
  return fetchJson(
    `${base(variant)}/questions/${encodeURIComponent(language)}?offset=${offset}&limit=${limit}`
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
  },
  variant: CombinedQuizVariant = "combined"
): Promise<CombinedQuizSession> {
  return putJson(
    `${base(variant)}/session/language/${encodeURIComponent(language)}/weights`,
    weights
  );
}

export function answerCombinedQuestion(
  opts: {
    language: string;
    kind: "word" | "grammar";
    refId: string;
    correct: boolean;
    flagWordIds?: string[];
  },
  variant: CombinedQuizVariant = "combined"
): Promise<{ session: CombinedQuizSession }> {
  return postJson<{ session: CombinedQuizSession }>(`${base(variant)}/answer`, opts);
}
