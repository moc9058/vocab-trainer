import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkTerms } from "../api/vocab";
import { categoryGroups, type GrammarGroup, type ImportItem, type WordGroup } from "../types";
import { registeredTerms } from "../utils/importSession";

/** A term field is looked up once typing settles, not on every keystroke. */
const LOOKUP_DEBOUNCE_MS = 400;

/** The groups holding one entity, split by meta-group. Names, because that is what
 *  the review screen shows and what a Group B set is joined by. */
export interface GroupMembership {
  a: string[];
  b: string[];
  /** IDs of the category-A groups holding the entity. The Group A destination is
   *  chosen by ID, so "is it already in the destination?" — which is what decides
   *  whether the row still offers an A button — has to be answered by ID. The name
   *  lists above are what the chips render. Group B needs no equivalent: a B study
   *  set is joined across domains by NAME, so `b` is already the right key. */
  aIds: string[];
}

const NO_GROUPS: GroupMembership = { a: [], b: [], aIds: [] };

export interface ImportLibraryStatus {
  /** Terms known to be in the library. Group A is the universe of all items, so
   *  this is exactly "already in Group A" — kept as the fallback signal for a term
   *  whose word ID is not known and whose group names therefore cannot be. */
  inLibrary: Set<string>;
  /** Group names holding each extracted term. Empty when the word ID is unknown. */
  wordGroupsByTerm: Map<string, GroupMembership>;
  /** Group names holding each registered grammar item, keyed by grammar ID —
   *  grammar rows carry their ID directly, so no statement→ID map is needed. */
  grammarGroupsById: Map<string, GroupMembership>;
}

/**
 * What the review screen knows about each extracted item's place in the library,
 * keyed by TERM rather than by row: an article repeats its vocabulary, so
 * registering 「経済」 in sentence 3 must also settle the 「経済」 rows in sentences 7
 * and 12 — and any row a split has just produced.
 *
 * Three sources feed it, cheapest first:
 *  1. the analysis, which had every extracted term looked up server-side
 *     (`existingWordId`) — never re-queried, that would cost one lookup per word
 *     of the article on every open;
 *  2. registrations made during this review, which propagate the entity ID onto
 *     every row sharing the term;
 *  3. a debounced `check-terms` for terms 1 and 2 cannot answer — the parts of a
 *     split, a merged compound, a hand-added row, a materialized gap.
 *
 * Group membership itself comes from the shared `useImportGroups` read, inverted
 * here. `overlay` covers the gap between a registration's write returning and that
 * re-read landing, so a chip never waits on a round trip to appear.
 */
export function useImportLibraryStatus(
  sessionId: string,
  language: string,
  items: ImportItem[],
  wordGroups: WordGroup[],
  grammarGroups: GrammarGroup[],
  /** `entityId → groupIds` written by registrations that the group read may not
   *  have caught up with yet. */
  overlay: Map<string, string[]>
): ImportLibraryStatus {
  const [lookedUp, setLookedUp] = useState<Map<string, string>>(() => new Map());
  /** term → the status phase it was last queried in, so a row that gets registered
   *  is asked about again (that is when its ID first becomes learnable). */
  const queriedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    queriedRef.current = new Map();
    setLookedUp(new Map());
  }, [sessionId]);

  const knownTerms = useMemo(() => registeredTerms(items), [items]);

  /** Word IDs the analysis already resolved, plus everything learned since. */
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
      // again once it has been registered and therefore has an ID to learn. A gap
      // row was never in that check — the `existing` map only covers terms the
      // model returned — so it is always a candidate.
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

  // ---- membership, inverted from the shared group read ----
  // Both categories, not just B: knowing the actual Group A group names is what
  // distinguishes "in the library" from "in the group this review is filling".
  const membershipByEntityId = useMemo(() => {
    const map = new Map<string, GroupMembership>();
    const add = (entityId: string, group: { id: string; name: string }, category: "A" | "B") => {
      const entry = map.get(entityId) ?? { a: [], b: [], aIds: [] };
      const bucket = category === "B" ? entry.b : entry.a;
      if (!bucket.includes(group.name)) bucket.push(group.name);
      if (category === "A" && !entry.aIds.includes(group.id)) entry.aIds.push(group.id);
      map.set(entityId, entry);
    };
    for (const category of ["A", "B"] as const) {
      for (const g of categoryGroups(wordGroups, category)) {
        for (const wordId of g.wordIds ?? []) add(wordId, g, category);
      }
      for (const g of categoryGroups(grammarGroups, category)) {
        for (const grammarId of g.grammarIds ?? []) add(grammarId, g, category);
      }
    }
    // The overlay is a union, never a replacement: it holds only what the newest
    // registrations wrote, while the read above holds everything else.
    const byId = new Map<string, { id: string; name: string; category: "A" | "B" }>();
    for (const g of wordGroups) {
      byId.set(g.id, { id: g.id, name: g.name, category: g.category ?? "A" });
    }
    for (const g of grammarGroups) {
      byId.set(g.id, { id: g.id, name: g.name, category: g.category ?? "A" });
    }
    for (const [entityId, groupIds] of overlay) {
      for (const groupId of groupIds) {
        const group = byId.get(groupId);
        // A group created inline during this registration is not in the read yet;
        // it arrives with the next one, which the write already scheduled.
        if (group) add(entityId, group, group.category);
      }
    }
    return map;
  }, [grammarGroups, overlay, wordGroups]);

  const inLibrary = useMemo(
    () => new Set([...knownTerms, ...idByTerm.keys()]),
    [idByTerm, knownTerms]
  );

  const wordGroupsByTerm = useMemo(() => {
    const map = new Map<string, GroupMembership>();
    for (const [term, wordId] of idByTerm) {
      map.set(term, membershipByEntityId.get(wordId) ?? NO_GROUPS);
    }
    return map;
  }, [idByTerm, membershipByEntityId]);

  return { inLibrary, wordGroupsByTerm, grammarGroupsById: membershipByEntityId };
}
