import { ApiError, fetchJson, postJson, putJson } from "./client";
import type { CombinedQuizSession, MixWeightConfig } from "../types";

/** Which of the identical route trees to talk to. "groupB" drills only the category-B
 *  groups; "mixed" spans both categories in one session; "importA"/"importB" drill the
 *  vocabulary and grammar of every saved article. Each keeps its own session per language,
 *  so all five can be in progress at once. */
export type CombinedQuizVariant = "combined" | "groupB" | "mixed" | "importA" | "importB";

/** A total map rather than an if-chain with a fallback: a variant added to the union but
 *  not given a path is a compile error here, instead of silently posting its answers into
 *  the plain Group A session. */
const VARIANT_BASE: Record<CombinedQuizVariant, string> = {
  combined: "/api/combined-quiz",
  groupB: "/api/group-b-quiz",
  mixed: "/api/mixed-quiz",
  importA: "/api/import-quiz-a",
  importB: "/api/import-quiz-b",
};

function base(variant: CombinedQuizVariant = "combined"): string {
  return VARIANT_BASE[variant];
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
    /** Mixed quiz only: the three-level ratios `domainWeights`/`groupWeights` were folded from.
     *  Stored verbatim so the mid-session ⚖ panel can show them back — see `MixWeightConfig`. */
    mixWeights?: MixWeightConfig;
    correctWeight?: number;
    /** Order the union by one uniform shuffle instead of merging the two domains by
     *  weight — see `CombinedQuizSession.randomOrder`. */
    randomOrder?: boolean;
    word?: {
      topics?: string[];
      categories?: string[];
      levels?: string[];
      groupIds?: string[];
      groupWeights?: Record<string, number>;
      flaggedOnly?: boolean;
      /** Explicit pool, bypassing every other word filter. */
      wordIds?: string[];
    };
    grammar?: {
      groupIds?: string[];
      groupWeights?: Record<string, number>;
      /** Explicit pool, bypassing the group scoping. */
      grammarIds?: string[];
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
    mixWeights?: MixWeightConfig;
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
