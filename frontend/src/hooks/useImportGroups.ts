import { useCallback, useEffect, useRef, useState } from "react";
import { getGroups } from "../api/vocab";
import { getGrammarGroups } from "../api/grammar";
import type { GrammarGroup, WordGroup } from "../types";

/**
 * Registrations arrive in bursts — the add queue runs `CONCURRENCY = 4` — and
 * `getWordGroups` returns every group with its complete `wordIds`, so it is
 * O(library size). Coalesce a burst into one re-read.
 */
const RELOAD_DEBOUNCE_MS = 400;

export interface ImportGroups {
  /** ALL word groups of the language — both categories. Callers filter with
   *  `categoryGroups`; the membership map needs A and B, the rail only A. */
  wordGroups: WordGroup[];
  grammarGroups: GrammarGroup[];
  /** True until the first fetch settles, so a caller can tell "no groups" from
   *  "not known yet" — the difference between showing an empty state and showing
   *  nothing at all. */
  loading: boolean;
  /** Re-read both collections. Called after a registration writes membership;
   *  debounced, so a burst of registrations costs one re-read. */
  reload: () => void;
}

/**
 * The review screen's one read of the group collections.
 *
 * It used to take three: `ImportDestinationRail` fetched both collections for its
 * selects, `useImportLibraryStatus` fetched the word groups again to invert
 * `wordIds` into membership, and `GroupBUnifiedSelect` fetched both a third time
 * through `loadGroupBGroups`. The documents are identical in all three cases —
 * `WordGroup` already carries `wordIds`, so the membership data was on screen twice
 * and thrown away once.
 *
 * Sharing one copy is also what makes membership feel immediate: after a
 * registration there is a single `reload()` to call, and it refreshes the chips and
 * the destination selects together rather than leaving them to disagree.
 */
export function useImportGroups(language: string): ImportGroups {
  const [wordGroups, setWordGroups] = useState<WordGroup[]>([]);
  const [grammarGroups, setGrammarGroups] = useState<GrammarGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRevision((r) => r + 1);
    }, RELOAD_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  // Each revision starts its own fetch and the previous one stops being allowed to
  // apply. Overlap is fine — these are GETs, and the debounce already keeps a burst
  // of registrations down to one — so last-write-wins is exactly the right rule:
  // gating on an in-flight request instead risks applying a response that predates
  // the write which asked for the reload.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getGroups(language).catch(() => [] as WordGroup[]),
      getGrammarGroups(language).catch(() => [] as GrammarGroup[]),
    ]).then(([words, grammar]) => {
      if (cancelled) return;
      setWordGroups(words);
      setGrammarGroups(grammar);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [language, revision]);

  return { wordGroups, grammarGroups, loading, reload };
}
