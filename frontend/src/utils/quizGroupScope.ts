// Pure helpers for scoping a quiz's group selection to one or both meta-groups.
// Kept out of the modal so the weight arithmetic can be reasoned about (and exercised)
// on its own — same split as utils/weightInput.ts and utils/quizLocal.ts.

import { categoryGroups, groupCategory, type GroupCategory } from "../types";
import { parseWeightInput, scaleWeightsToIntegers } from "./weightInput";

/** Which meta-group buckets a quiz draws from. "AB" is the mixed quiz — both at once. */
export type QuizGroupScope = GroupCategory | "AB";

/**
 * Groups that contributed at least one item to the session's actual question set.
 *
 * A selected group with weight 0 is still present in the membership snapshot, but the
 * backend drops its bucket while building the session. Keeping this distinction explicit
 * prevents the mid-session weight editor from offering a control that cannot add those
 * omitted items back into the already-created quiz.
 */
export function representedGroupIds(
  membership: Record<string, string[]> | undefined,
  questionIds: ReadonlySet<string>
): Set<string> {
  return new Set(
    Object.entries(membership ?? {})
      .filter(([, memberIds]) => memberIds.some((id) => questionIds.has(id)))
      .map(([groupId]) => groupId)
  );
}

/** Persist the user-facing group weights without integer scaling or mixed-quiz folding. */
export function serializeGroupWeightDraft(
  groupIds: Iterable<string>,
  draft: Record<string, string>
): Record<string, number> {
  return Object.fromEntries(
    [...groupIds].map((id) => [id, Math.max(0, parseWeightInput(draft[id] ?? "1") ?? 0)])
  );
}

/**
 * Seed the group editor from the original inputs when available. For older mixed sessions,
 * effective weights can be reduced independently inside A and B: folding multiplies every
 * group in one category by the same factor, so this recovers the smallest equivalent ratios.
 * Without category metadata, retain the effective weights as the lossless fallback.
 */
export function restoreGroupWeightDraft(
  groupIds: Iterable<string>,
  original: Record<string, number> | undefined,
  effective: Record<string, number> | undefined,
  categoryByGroup?: ReadonlyMap<string, GroupCategory>
): Record<string, string> {
  const ids = [...groupIds];
  if (original && Object.keys(original).length > 0) {
    return Object.fromEntries(
      ids.map((id) => [id, String(original[id] ?? effective?.[id] ?? 1)])
    );
  }
  if (!categoryByGroup || categoryByGroup.size === 0) {
    return Object.fromEntries(ids.map((id) => [id, String(effective?.[id] ?? 1)]));
  }

  const restored: Record<string, string> = {};
  for (const cat of CATEGORIES) {
    const categoryIds = ids.filter((id) => (categoryByGroup.get(id) ?? "A") === cat);
    const normalized = scaleWeightsToIntegers(
      categoryIds.map((id) => String(effective?.[id] ?? 1))
    );
    categoryIds.forEach((id, index) => {
      restored[id] = String(normalized[index]);
    });
  }
  return restored;
}

/**
 * The groups this scope offers, in the order they must be SENT.
 *
 * For "AB" that order is load-bearing: the backend's `assignMembership`
 * (routes/combined-quiz.ts) gives each item to the FIRST group in `groupIds` that holds it,
 * so listing B first is what makes a word sitting in both an A lesson and a B study set
 * count against B's weight rather than A's.
 */
export function scopedGroups<T extends { category?: GroupCategory }>(
  groups: T[],
  scope: QuizGroupScope
): T[] {
  if (scope !== "AB") return categoryGroups(groups, scope);
  return [...categoryGroups(groups, "B"), ...categoryGroups(groups, "A")];
}

/**
 * Fold the A↔B category ratio into the per-group weights.
 *
 * The backend weights buckets per GROUP, not per category, so a category ratio has to be
 * expressed in the group weights themselves: scale each side so its weights sum in
 * `catWeights` proportion, however many groups sit on each side. Group weights stay
 * relative WITHIN a category.
 *
 * Scaling each side by the OTHER side's weight-sum reaches that without dividing —
 * `a_i * wA * S_B` vs `b_j * wB * S_A` sum to `wA*S_A*S_B : wB*S_A*S_B` = `wA : wB` —
 * so integer inputs stay integers for `scaleWeightRecord` to GCD-reduce afterwards.
 *
 * A category with nothing selected contributes a sum of 0, which would zero out the other
 * side too, so it scales by 1 instead.
 */
export function applyCategoryRatio(
  groups: { id: string; category?: GroupCategory }[],
  selected: Set<string>,
  raw: Record<string, string>,
  catWeights: { A: number; B: number }
): Record<string, string> {
  const weightOf = (id: string) => parseWeightInput(raw[id] ?? "1") ?? 0;
  const sum = { A: 0, B: 0 };
  for (const g of groups) {
    if (selected.has(g.id)) sum[groupCategory(g)] += weightOf(g.id);
  }
  const scale = {
    A: catWeights.A * (sum.B > 0 ? sum.B : 1),
    B: catWeights.B * (sum.A > 0 ? sum.A : 1),
  };
  return Object.fromEntries(
    groups
      .filter((g) => selected.has(g.id))
      .map((g) => [g.id, String(weightOf(g.id) * scale[groupCategory(g)])])
  );
}

// ===== Three-level weights (the mixed A+B quiz) =====
//
// The mixed quiz balances THREE nested things: the A↔B category ratio, then word↔grammar
// INDEPENDENTLY within each category, then the individual groups. The backend has no
// category concept at all — it takes one `domainWeights {word, grammar}` pair plus per-group
// weights — so all three levels are folded into those two knobs here.

/** The mixed quiz's weight form, held as raw strings like every other weight input
 *  (see `utils/weightInput.ts` for why they are not numbers until submission). */
export interface MixWeightDraft {
  category: { A: string; B: string };
  domain: { A: { word: string; grammar: string }; B: { word: string; grammar: string } };
}

/** One (category, domain) bucket's effective weight — the four numbers the whole fold is
 *  expressed in terms of. */
export type CategoryDomainWeights = Record<GroupCategory, { word: number; grammar: number }>;

const DOMAINS = ["word", "grammar"] as const;
const CATEGORIES: GroupCategory[] = ["A", "B"];

/**
 * A folded weight is a product of up to four user-typed numbers, so decimal inputs land on
 * float noise — `0.1 * 3` is `0.30000000000000004`. Left alone, `decimalPlaces` reads that as
 * 17 places and `scaleWeightsToIntegers` multiplies by 1e17, past `Number.MAX_SAFE_INTEGER`.
 * Six places is far more precision than a draw ratio can express and clears the noise.
 */
function roundWeight(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * The four effective (category, domain) weights.
 *
 * Each category's word:grammar pair is scaled by the OTHER category's pair-sum, which lands
 * the A:B ratio exactly without dividing — the same trick `applyCategoryRatio` uses one level
 * down, and the reason integer inputs stay integers for `scaleWeightRecord` to GCD-reduce.
 *
 *   sA = dA.word + dA.grammar          sB = dB.word + dB.grammar
 *   p[A][k] = dA[k] * wA * sB          p[B][k] = dB[k] * wB * sA
 *
 * so A's total is `wA*sA*sB` against B's `wB*sB*sA` = `wA : wB`, while `p[A].word : p[A].grammar`
 * is still `dA.word : dA.grammar`. A category whose domains are all zero scales by 1 rather
 * than 0, which would otherwise wipe out the other side too.
 */
export function categoryDomainWeights(draft: MixWeightDraft): CategoryDomainWeights {
  const num = (raw: string) => parseWeightInput(raw) ?? 0;
  const sum = {
    A: num(draft.domain.A.word) + num(draft.domain.A.grammar),
    B: num(draft.domain.B.word) + num(draft.domain.B.grammar),
  };
  const scale = {
    A: num(draft.category.A) * (sum.B > 0 ? sum.B : 1),
    B: num(draft.category.B) * (sum.A > 0 ? sum.A : 1),
  };
  return {
    A: {
      word: roundWeight(num(draft.domain.A.word) * scale.A),
      grammar: roundWeight(num(draft.domain.A.grammar) * scale.A),
    },
    B: {
      word: roundWeight(num(draft.domain.B.word) * scale.B),
      grammar: roundWeight(num(draft.domain.B.grammar) * scale.B),
    },
  };
}

/**
 * Fold a three-level draft down to the two knobs the backend understands.
 *
 *   domainWeights[k]  = p.A[k] + p.B[k]
 *   group weights     = applyCategoryRatio(..., { A: p.A[k], B: p.B[k] })
 *
 * The backend then draws a domain bucket and, within it, a group bucket, so the two stages
 * multiply back to exactly `p`: `share(A,word) = (pAw+pBw)/T × pAw/(pAw+pBw) = pAw/T`.
 *
 * With A:B = 2:1, A at 3:1 and B at 1:2, that is `p = 18, 6, 4, 8` →
 * `domainWeights {word: 22, grammar: 14}`, word groups A:B = 9:2, grammar groups A:B = 3:4.
 *
 * A category only contributes to a domain when it has a group selected there: otherwise
 * `p.B.grammar` would inflate the grammar bucket with nothing for it to draw. With neither
 * category represented the domain falls back to the plain sum, matching the ungrouped path.
 *
 * Returns raw strings so the caller can still run the domain record through
 * `scaleWeightRecord` alongside the "already-correct" weight, exactly as before.
 */
export function foldMixWeights(args: {
  draft: MixWeightDraft;
  wordGroups: { id: string; category?: GroupCategory }[];
  selectedWord: Set<string>;
  wordRaw: Record<string, string>;
  grammarGroups: { id: string; category?: GroupCategory }[];
  selectedGrammar: Set<string>;
  grammarRaw: Record<string, string>;
}): {
  domain: { word: string; grammar: string };
  wordGroupWeights: Record<string, string>;
  grammarGroupWeights: Record<string, string>;
} {
  const p = categoryDomainWeights(args.draft);
  const byDomain = {
    word: { groups: args.wordGroups, selected: args.selectedWord, raw: args.wordRaw },
    grammar: { groups: args.grammarGroups, selected: args.selectedGrammar, raw: args.grammarRaw },
  };

  const domain = {} as { word: string; grammar: string };
  const folded = {} as Record<"word" | "grammar", Record<string, string>>;
  for (const k of DOMAINS) {
    const { groups, selected, raw } = byDomain[k];
    const represented = CATEGORIES.filter((cat) =>
      groups.some((g) => selected.has(g.id) && groupCategory(g) === cat)
    );
    const contributing = represented.length > 0 ? represented : CATEGORIES;
    domain[k] = String(roundWeight(contributing.reduce((total, cat) => total + p[cat][k], 0)));
    const ratioed = applyCategoryRatio(groups, selected, raw, { A: p.A[k], B: p.B[k] });
    folded[k] = Object.fromEntries(
      Object.entries(ratioed).map(([id, w]) => [id, String(roundWeight(Number(w)))])
    );
  }

  return {
    domain,
    wordGroupWeights: folded.word,
    grammarGroupWeights: folded.grammar,
  };
}
