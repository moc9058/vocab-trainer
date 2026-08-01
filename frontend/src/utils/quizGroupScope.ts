// Pure helpers for scoping a quiz's group selection to one or both meta-groups.
// Kept out of the modal so the weight arithmetic can be reasoned about (and exercised)
// on its own — same split as utils/weightInput.ts and utils/quizLocal.ts.

import { categoryGroups, groupCategory, type GroupCategory } from "../types";
import { parseWeightInput } from "./weightInput";

/** Which meta-group buckets a quiz draws from. "AB" is the mixed quiz — both at once. */
export type QuizGroupScope = GroupCategory | "AB";

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
