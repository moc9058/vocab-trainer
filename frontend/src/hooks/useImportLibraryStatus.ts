import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkTerms, getGroups } from "../api/vocab";
import { categoryGroups, type ImportItem } from "../types";
import { registeredTerms } from "../utils/importSession";

/** A term field is looked up once typing settles, not on every keystroke. */
const LOOKUP_DEBOUNCE_MS = 400;

export interface ImportLibraryStatus {
  /** Terms known to be in the library. Group A is the universe of all items, so
   *  this is exactly "already in Group A". */
  inLibrary: Set<string>;
  /** Category-B group names holding the term — empty when it is in none. */
  groupBByTerm: Map<string, string[]>;
}

/**
 * What the review screen knows about each extracted term's place in the library,
 * keyed by TERM rather than by row: an article repeats its vocabulary, so
 * registering 「経済」 in sentence 3 must also settle the 「経済」 rows in sentences 7
 * and 12 — and any row a split has just produced.
 *
 * Three sources feed it, cheapest first:
 *  1. the analysis, which had every extracted term looked up server-side
 *     (`existingWordId`) — never re-queried, that would cost one lookup per word
 *     of the article on every open;
 *  2. registrations made during this review;
 *  3. a debounced `check-terms` for terms 1 and 2 cannot answer — the parts of a
 *     split, a merged compound, a hand-added row.
 *
 * Group B membership needs the word's ID, so it can only be reported for terms
 * whose ID is known; the group lists are refetched as new IDs come in.
 */
export function useImportLibraryStatus(
  sessionId: string,
  language: string,
  items: ImportItem[]
): ImportLibraryStatus {
  const [lookedUp, setLookedUp] = useState<Map<string, string>>(() => new Map());
  const [groupBWordIds, setGroupBWordIds] = useState<Map<string, string[]>>(() => new Map());
  /** term → the status phase it was last queried in, so a row that gets registered
   *  is asked about again (that is when its ID first becomes learnable). */
  const queriedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    queriedRef.current = new Map();
    setLookedUp(new Map());
  }, [sessionId]);

  const knownTerms = useMemo(() => registeredTerms(items), [items]);

  /** Word IDs the analysis already resolved, plus everything looked up since. */
  const idByTerm = useMemo(() => {
    const map = new Map<string, string>(lookedUp);
    for (const i of items) {
      if (i.kind !== "word" || !i.existingWordId) continue;
      const term = i.term.trim();
      if (term) map.set(term, i.existingWordId);
    }
    return map;
  }, [items, lookedUp]);

  const phaseOf = useCallback(
    (term: string) =>
      items.some(
        (i) =>
          i.kind === "word" &&
          i.term.trim() === term &&
          (i.status === "registered" || i.status === "duplicate")
      )
        ? "done"
        : "open",
    [items]
  );

  // ---- 3. lookup for terms nothing else can answer ----
  useEffect(() => {
    const candidates = new Set<string>();
    for (const i of items) {
      if (i.kind !== "word" || i.status === "skipped") continue;
      const term = i.term.trim();
      if (!term || idByTerm.has(term)) continue;
      // An LLM-proposed row was checked server-side at analysis time; only ask
      // again once it has been registered and therefore has an ID to learn.
      const settled = i.status === "registered" || i.status === "duplicate";
      if (i.origin === "llm" && !settled) continue;
      if (queriedRef.current.get(term) === phaseOf(term)) continue;
      candidates.add(term);
    }
    if (candidates.size === 0) return;

    const terms = [...candidates];
    const timer = setTimeout(() => {
      terms.forEach((term) => queriedRef.current.set(term, phaseOf(term)));
      checkTerms(language, terms)
        .then(({ existing }) => {
          if (Object.keys(existing).length === 0) return;
          setLookedUp((prev) => new Map([...prev, ...Object.entries(existing)]));
        })
        // A failed lookup must not stick: allow the next pass to retry it.
        .catch(() => terms.forEach((term) => queriedRef.current.delete(term)));
    }, LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [idByTerm, items, language, phaseOf]);

  // ---- Group B membership ----
  // Refetched whenever a new word ID enters the picture (a registration, a
  // lookup), since that is the only thing that can change what B holds here.
  const idSignature = useMemo(() => [...idByTerm.values()].sort().join(","), [idByTerm]);
  useEffect(() => {
    let cancelled = false;
    getGroups(language)
      .then((groups) => {
        if (cancelled) return;
        const map = new Map<string, string[]>();
        for (const group of categoryGroups(groups, "B")) {
          for (const wordId of group.wordIds ?? []) {
            map.set(wordId, [...(map.get(wordId) ?? []), group.name]);
          }
        }
        setGroupBWordIds(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [language, idSignature]);

  const inLibrary = useMemo(
    () => new Set([...knownTerms, ...idByTerm.keys()]),
    [idByTerm, knownTerms]
  );

  const groupBByTerm = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [term, wordId] of idByTerm) {
      const names = groupBWordIds.get(wordId);
      if (names?.length) map.set(term, names);
    }
    return map;
  }, [groupBWordIds, idByTerm]);

  return { inLibrary, groupBByTerm };
}
