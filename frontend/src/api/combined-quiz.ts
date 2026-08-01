import { ApiError, fetchJson, postJson, putJson } from "./client";
import type { CombinedQuizSession } from "../types";

/** Which of the three identical route trees to talk to. "groupB" drills only the
 *  category-B groups; "mixed" spans both categories in one session. Each keeps its own
 *  session per language, so all three can be in progress at once. */
export type CombinedQuizVariant = "combined" | "groupB" | "mixed";

function base(variant: CombinedQuizVariant = "combined"): string {
  if (variant === "groupB") return "/api/group-b-quiz";
  if (variant === "mixed") return "/api/mixed-quiz";
  return "/api/combined-quiz";
}

/** `null` means "no session" (404) only; other failures rethrow — see `api/quiz.ts`. */
export async function getCurrentCombinedSession(
  language: string,
  variant: CombinedQuizVariant = "combined"
): Promise<CombinedQuizSession | null> {
  try {
    return await fetchJson<CombinedQuizSession>(
      `${base(variant)}/session/language/${encodeURIComponent(language)}`
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
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

// No hydration helper here: word questions go through the shared `hydrateQuizQuestions`
// (api/quiz.ts) and grammar questions through `getGrammarItemsByIds` (api/grammar.ts).

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
