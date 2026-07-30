import { useCallback, useEffect, useRef, useState } from "react";
import {
  createImportSession,
  getImportSession,
  updateImportSession,
} from "../api/import";
import { checkTerms, modifyGroupMembers } from "../api/vocab";
import { modifyGrammarGroupMembers } from "../api/grammar";
import { resolveGroupBTargets } from "../utils/groupB";
import { flattenSentences, isLive, isLocked } from "../utils/importSession";
import type { ImportItem, ImportSession, ImportWordItem } from "../types";
import type { useWordQueue } from "./useWordQueue";
import type { useGrammarQueue } from "./useGrammarQueue";

type WordEnqueue = ReturnType<typeof useWordQueue>["enqueue"];
type GrammarEnqueue = ReturnType<typeof useGrammarQueue>["enqueue"];

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Free-text edits settle at this cadence; everything consequential flushes at once. */
const AUTOSAVE_DEBOUNCE_MS = 1200;

type NewSessionInput = Omit<ImportSession, "id" | "language" | "createdAt" | "updatedAt">;

interface Options {
  /** Backend full-name language, e.g. "chinese". */
  language: string;
  onQueue: WordEnqueue;
  onGrammarQueue: GrammarEnqueue;
  /** ISO code the grammar description is written in (from `config/grammar_settings`). */
  descriptionLanguage: string;
  /** Fired once a registration has written group membership, so the shared group
   *  read can catch up. Debounced by `useImportGroups`. */
  onMembershipChanged?: () => void;
}

/**
 * What one registration attempt achieved. `entityId` is the word/grammar ID the
 * write landed on — reported so the row (and every row sharing its term) can say
 * something about the entity without a `check-terms` round trip. `groupIds` are the
 * groups membership was written into, which feeds the optimistic chip overlay.
 */
type SettleResult =
  | { ok: true; entityId?: string; groupIds: string[] }
  | { ok: false; error: string; duplicate: boolean; rescuedAsDraft: boolean };

/** The term (word) or statement (grammar) two rows must share to be "the same item". */
function itemKey(item: ImportItem): string {
  return item.kind === "word" ? item.term.trim() : item.statement.trim();
}

export function useImportSession({
  language,
  onQueue,
  onGrammarQueue,
  descriptionLanguage,
  onMembershipChanged,
}: Options) {
  const [session, setSessionState] = useState<ImportSession | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * Group IDs each just-registered entity was written into, `entityId → groupIds`.
   *
   * Deliberately NOT persisted on the items: the server is the real record, and a
   * re-read of the group collections answers the same question. This exists only to
   * cover the gap between "the write returned" and "the re-read landed", which is
   * what makes the Group A/B chips feel immediate. It is cleared whenever the
   * session changes, since the IDs belong to that review.
   */
  const [membershipOverlay, setMembershipOverlay] = useState<Map<string, string[]>>(
    () => new Map()
  );

  // The autosave timer and the queue's settle callbacks both fire outside React's
  // render flow, so they read the session through a ref rather than a stale closure.
  const sessionRef = useRef<ImportSession | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  const setSession = useCallback((next: ImportSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  // ---------- saving ----------

  const save = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    if (savingRef.current) {
      // Exactly one PUT in flight; the follow-up re-reads current state, so the
      // last write always carries the newest edits.
      pendingRef.current = true;
      return;
    }
    savingRef.current = true;
    dirtyRef.current = false;
    setSaveStatus("saving");
    try {
      const saved = await updateImportSession(language, current.id, {
        title: current.title,
        items: current.items,
        wordGroupId: current.wordGroupId,
        grammarGroupId: current.grammarGroupId,
        groupBNames: current.groupBNames,
        focusedSentenceIndex: current.focusedSentenceIndex,
        status: current.status,
      });
      // Only the server-owned stamp is taken back; local state stays authoritative
      // so edits made during the request are not reverted.
      if (sessionRef.current) {
        setSession({ ...sessionRef.current, updatedAt: saved.updatedAt });
      }
      setSaveStatus("saved");
      setSaveError(null);
    } catch (err) {
      dirtyRef.current = true;
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      savingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void save();
      }
    }
  }, [language, setSession]);

  /** Save now, skipping the debounce — used for anything costly to lose. */
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void save();
  }, [save]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void save();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [save]);

  // A pending debounce would otherwise be dropped when the view unmounts.
  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        if (sessionRef.current && dirtyRef.current) void save();
      }
    },
    [save]
  );

  // Last line of defence for a tab closed mid-edit.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // ---------- lifecycle ----------

  /** Created the moment the analysis lands, so the expensive LLM result is never at risk. */
  const create = useCallback(
    async (input: NewSessionInput): Promise<ImportSession> => {
      const created = await createImportSession(language, input);
      setMembershipOverlay(new Map());
      setSession(created);
      setSaveStatus("saved");
      return created;
    },
    [language, setSession]
  );

  /**
   * Loads a session and reconciles it with the DB: any word row left `queued` by a
   * tab that closed mid-flight is resolved against `check-terms`, which is the only
   * ground truth available. Grammar has no existence check by design, so those rows
   * keep their unverified status rather than being promoted on a guess.
   */
  const load = useCallback(
    async (sessionId: string): Promise<ImportSession> => {
      const loaded = await getImportSession(language, sessionId);
      const queuedWords = loaded.items.filter(
        (i): i is ImportWordItem => i.kind === "word" && i.status === "queued"
      );
      let items = loaded.items;
      if (queuedWords.length > 0) {
        try {
          const { existing } = await checkTerms(
            language,
            [...new Set(queuedWords.map((w) => w.term.trim()).filter(Boolean))]
          );
          items = items.map((i) =>
            i.kind === "word" && i.status === "queued" && existing[i.term.trim()]
              ? { ...i, status: "registered" as const, existingWordId: existing[i.term.trim()] }
              : i
          );
        } catch {
          // Reconciliation is best-effort; unresolved rows stay visibly unverified.
        }
      }
      const next = { ...loaded, items };
      setMembershipOverlay(new Map());
      setSession(next);
      setSaveStatus("saved");
      return next;
    },
    [language, setSession]
  );

  /** Leaving the review must not drop a debounce that has not fired yet. */
  const close = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (dirtyRef.current) void save();
    dirtyRef.current = false;
    setMembershipOverlay(new Map());
    setSession(null);
    setSaveStatus("idle");
    setSaveError(null);
  }, [save, setSession]);

  // ---------- editing ----------

  /** Every mutation goes through here so nothing can change without an autosave. */
  const patch = useCallback(
    (updater: (s: ImportSession) => ImportSession, immediate = false) => {
      const current = sessionRef.current;
      if (!current) return;
      setSession(updater(current));
      if (immediate) flush();
      else scheduleSave();
    },
    [flush, scheduleSave, setSession]
  );

  const setItems = useCallback(
    (updater: (items: ImportItem[]) => ImportItem[], immediate = false) => {
      patch((s) => ({ ...s, items: updater(s.items) }), immediate);
    },
    [patch]
  );

  const patchItem = useCallback(
    (id: string, updates: Partial<ImportItem>, immediate = false) => {
      setItems(
        (items) => items.map((i) => (i.id === id ? ({ ...i, ...updates } as ImportItem) : i)),
        immediate
      );
    },
    [setItems]
  );

  // ---------- registration ----------

  // `resolveGroupBTargets` CREATES the missing side of a Group B group, so calling
  // it per add would be both wasteful and racy. One in-flight promise per domain,
  // invalidated whenever the selected names change.
  const groupBCache = useRef<{
    key: string;
    word?: Promise<string[]>;
    grammar?: Promise<string[]>;
  }>({ key: "" });

  const groupBIdsFor = useCallback(
    (kind: "word" | "grammar"): Promise<string[]> => {
      const names = sessionRef.current?.groupBNames ?? [];
      if (names.length === 0) return Promise.resolve([]);
      const key = names.join(" ");
      if (groupBCache.current.key !== key) groupBCache.current = { key };
      const cached = groupBCache.current[kind];
      if (cached) return cached;
      const promise = resolveGroupBTargets(language, names, {
        words: kind === "word",
        grammar: kind === "grammar",
      })
        .then((r) => (kind === "word" ? r.wordGroupIds : r.grammarGroupIds))
        .catch((err) => {
          groupBCache.current[kind] = undefined; // let the next attempt retry
          throw err;
        });
      groupBCache.current[kind] = promise;
      return promise;
    },
    [language]
  );

  const sentenceText = useCallback((sentenceIndex: number): string => {
    const s = sessionRef.current;
    if (!s) return "";
    return flattenSentences(s.paragraphs).find((x) => x.index === sentenceIndex)?.text ?? "";
  }, []);

  /**
   * Writes one registration outcome to the row AND to every live row that holds the
   * same term (word) or statement (grammar).
   *
   * An article repeats its vocabulary, so the entity ID learned here is knowledge
   * about the TERM, not about this row: propagating it is what makes the other rows
   * show their real library and group state, and what makes their add button take the
   * cheap group-membership-only path instead of a smart-add that would come back 409
   * with its group work skipped.
   *
   * Status, by contrast, is per-row truth and is NOT propagated — marking untouched
   * rows `registered` would inflate the progress counter and lock them out of
   * "Add to groups" after the destination changes. The one exception is a row left
   * `queued` by the piggyback guard below: it has no write of its own to wait for, so
   * it takes this one's terminal status or it would spin forever.
   *
   * Everything lands in a SINGLE `setItems` — two `immediate` patches would each
   * flush, costing a second PUT for one logical change.
   */
  const applySettle = useCallback(
    (id: string, result: SettleResult) => {
      setItems((items) => {
        const target = items.find((i) => i.id === id);
        if (!target) return items;
        const key = itemKey(target);
        const idField = target.kind === "word" ? "existingWordId" : "existingGrammarId";
        const terminal = result.ok
          ? { status: "registered" as const, error: undefined }
          : result.duplicate
          ? { status: "duplicate" as const, error: undefined }
          : { status: "failed" as const, error: result.error };

        return items.map((i) => {
          const learnedId =
            result.ok && result.entityId ? { [idField]: result.entityId } : {};
          if (i.id === id) {
            return {
              ...i,
              ...terminal,
              ...learnedId,
              // Only the row that actually attempted the write can claim the rescue.
              ...(result.ok ? {} : { rescuedAsDraft: result.rescuedAsDraft }),
            } as ImportItem;
          }
          if (!isLive(i) || i.kind !== target.kind || itemKey(i) !== key) return i;
          const withId = { ...i, ...learnedId } as ImportItem;
          return i.status === "queued" ? ({ ...withId, ...terminal } as ImportItem) : withId;
        });
      }, true);

      if (result.ok && result.entityId && result.groupIds.length > 0) {
        const { entityId, groupIds } = result;
        setMembershipOverlay((prev) => {
          const next = new Map(prev);
          next.set(entityId, [...new Set([...(next.get(entityId) ?? []), ...groupIds])]);
          return next;
        });
      }
      if (result.ok && result.groupIds.length > 0) onMembershipChanged?.();
    },
    [onMembershipChanged, setItems]
  );

  /** Hands ONE item to the shared add queue and records its real outcome. */
  const registerItem = useCallback(
    async (id: string) => {
      const current = sessionRef.current;
      const item = current?.items.find((i) => i.id === id);
      if (!current || !item || isLocked(item)) return;
      const key = itemKey(item);
      if (!key) return;

      // An identical row already in flight will settle this one through sibling
      // propagation. Enqueueing a second write for the same term would race the
      // first (the queue runs 4 at a time) and at best come back 409 — which skips
      // the group work entirely.
      const piggyback = current.items.some(
        (i) =>
          i.id !== id &&
          isLive(i) &&
          i.status === "queued" &&
          i.kind === item.kind &&
          itemKey(i) === key
      );

      patchItem(id, { status: "queued", error: undefined, rescuedAsDraft: undefined }, true);
      if (piggyback) return;

      const settle = (result: SettleResult) => applySettle(id, result);
      const fail = (err: unknown) =>
        settle({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          duplicate: false,
          rescuedAsDraft: false,
        });

      let groupBIds: string[];
      try {
        groupBIds = await groupBIdsFor(item.kind);
      } catch (err) {
        fail(err);
        return;
      }

      if (item.kind === "word") {
        const groupIds = [
          ...new Set([...(current.wordGroupId ? [current.wordGroupId] : []), ...groupBIds]),
        ];
        /** Group membership for a word already in the DB. Firestore's group add is
         *  set-based, so re-adding a word that is already a member is a no-op. */
        const addToGroups = async (wordId: string) => {
          await Promise.all(groupIds.map((gid) => modifyGroupMembers(language, gid, [wordId], "add")));
        };

        if (item.existingWordId) {
          // Already in the DB: never re-created, only given group membership.
          const wordId = item.existingWordId;
          try {
            await addToGroups(wordId);
            settle({ ok: true, entityId: wordId, groupIds });
          } catch (err) {
            fail(err);
          }
          return;
        }
        const sentence = sentenceText(item.sentenceIndex);
        onQueue(
          item.term.trim(),
          language,
          {
            term: item.term.trim(),
            ...(item.transliteration?.trim()
              ? { transliteration: item.transliteration.trim() }
              : {}),
            // The row's gloss is an ANCHOR, not the final definition: smart-add still
            // asks the LLM for all four languages. It is what makes the meaning the
            // user typed after a split or a merge actually reach the new word.
            ...(item.meaning?.trim()
              ? {
                  definitions: [
                    { partOfSpeech: "", text: { [descriptionLanguage]: item.meaning.trim() } },
                  ],
                }
              : {}),
            ...(sentence ? { examples: [{ sentence, translation: "" }] } : {}),
            ...(groupIds.length > 0 ? { groupIds } : {}),
          },
          {
            onSettled: (result) => {
              if (result.ok) {
                settle({ ok: true, entityId: result.wordId, groupIds });
                return;
              }
              if (!result.duplicate) {
                settle(result);
                return;
              }
              // A 409 means the word IS in the DB but smart-add threw before the
              // queue's group work, so nothing was written. The row's whole purpose
              // was the group membership, so recover the ID and finish the job
              // rather than reporting a dead end. Stays `queued` (spinner) meanwhile.
              const term = item.term.trim();
              void (async () => {
                try {
                  const { existing } = await checkTerms(language, [term]);
                  const wordId = existing[term];
                  if (!wordId) {
                    settle(result);
                    return;
                  }
                  await addToGroups(wordId);
                  settle({ ok: true, entityId: wordId, groupIds });
                } catch {
                  settle(result);
                }
              })();
            },
          }
        );
        return;
      }

      const sentence = sentenceText(item.sentenceIndex);
      const groupIds = [
        ...new Set([...(current.grammarGroupId ? [current.grammarGroupId] : []), ...groupBIds]),
      ];

      // The same pattern is usually illustrated by several sentences, so the article
      // yields several rows for it. Once one of them has been registered its ID is on
      // all of them, and the rest extend group membership instead of creating a
      // duplicate — grammar smart-add has no existence check of its own, so without
      // this the same statement would be stored three times over.
      if (item.existingGrammarId) {
        const grammarId = item.existingGrammarId;
        try {
          await Promise.all(
            groupIds.map((gid) => modifyGrammarGroupMembers(language, gid, [grammarId], "add"))
          );
          settle({ ok: true, entityId: grammarId, groupIds });
        } catch (err) {
          fail(err);
        }
        return;
      }

      onGrammarQueue(
        item.statement.trim(),
        language,
        {
          id: `grammar-${language}-${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          statement: item.statement.trim(),
          descriptions: [
            { partOfSpeech: "", text: { [descriptionLanguage]: item.description.trim() } },
          ],
          ...(sentence ? { examples: [{ sentence, translation: "" }] } : {}),
        },
        {
          ...(groupIds.length > 0 ? { groupIds } : {}),
          // Grammar smart-add never returns 409 (no duplicate check server-side), so
          // there is no duplicate branch to recover here.
          onSettled: (result) =>
            settle(result.ok ? { ok: true, entityId: result.grammarId, groupIds } : result),
        }
      );
    },
    [
      applySettle,
      descriptionLanguage,
      groupBIdsFor,
      language,
      onGrammarQueue,
      onQueue,
      patchItem,
      sentenceText,
    ]
  );

  return {
    session,
    saveStatus,
    saveError,
    membershipOverlay,
    create,
    load,
    close,
    patch,
    setItems,
    patchItem,
    registerItem,
    flush,
    retrySave: flush,
  };
}
