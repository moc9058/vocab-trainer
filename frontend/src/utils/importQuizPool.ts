// Turning the article quizzes' raw entity union into the two pools the buttons offer.
// Pure and kept out of the component for the same reason as utils/importSession.ts —
// this is set arithmetic with a load-bearing asymmetry between A and B, and it should be
// readable (and testable) without a React tree around it.

import { categoryGroups } from "../types";
import type { GrammarGroup, ImportQuizPool, WordGroup } from "../types";

export interface ArticleQuizPools {
  /** Everything the saved articles point at that is in the library. */
  a: ImportQuizPool;
  /** The subset also sitting in a category-B group — the not-yet-memorized items. */
  b: ImportQuizPool;
}

export function poolSize(pool: ImportQuizPool): number {
  return pool.wordIds.length + pool.grammarIds.length;
}

function memberIds(groups: { wordIds?: string[]; grammarIds?: string[] }[]): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) {
    for (const id of g.wordIds ?? g.grammarIds ?? []) ids.add(id);
  }
  return ids;
}

/**
 * Split the articles' entity union into the Group A and Group B pools.
 *
 * **A is NOT intersected with the category-A groups, and that is deliberate.** The
 * codebase treats "in the library" and "in Group A" as the same statement for import
 * material — `utils/importSession.ts:registeredTerms` says so outright, and CLAUDE.md
 * calls A "the universe of all items". Every id in `pool` already came from an item
 * carrying an `existingWordId`/`existingGrammarId`, so it is in the library by
 * construction. Intersecting anyway would silently drop a word that is in the library but
 * in no group — and would empty the A quiz entirely for a language that has no category-A
 * groups yet, which is exactly when the article drill is most useful.
 *
 * **B is intersected**, because there the group membership IS the meaning: a category-B
 * group is a hand-picked subset, and "nothing marked B" is a real, correct empty answer
 * rather than a configuration gap. Note this makes B a subset of A, not a peer of it.
 */
export function deriveArticleQuizPools(
  pool: ImportQuizPool,
  wordGroups: WordGroup[],
  grammarGroups: GrammarGroup[]
): ArticleQuizPools {
  const bWordIds = memberIds(categoryGroups(wordGroups, "B"));
  const bGrammarIds = memberIds(categoryGroups(grammarGroups, "B"));
  return {
    a: pool,
    b: {
      wordIds: pool.wordIds.filter((id) => bWordIds.has(id)),
      grammarIds: pool.grammarIds.filter((id) => bGrammarIds.has(id)),
    },
  };
}
