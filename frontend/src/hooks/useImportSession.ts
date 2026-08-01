import { useCallback, useEffect, useRef, useState } from "react";
import {
  createImportSession,
  getImportSession,
  updateImportSession,
} from "../api/import";
import { checkTerms, modifyGroupMembers } from "../api/vocab";
import { modifyGrammarGroupMembers } from "../api/grammar";
import { resolveGroupBTargets } from "../utils/groupB";
import {
  flattenSentences,
  isLive,
  pendingTargets,
  withRegistration,
} from "../utils/importSession";
import type {
  ImportItem,
  ImportRegistrationState,
  ImportSession,
  ImportWordItem,
} from "../types";
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
  /**
   * `kind term` → the CREATE currently running for it.
   *
   * Group A and Group B are independent presses, and both can be aimed at a row whose
   * word does not exist yet. Without this they would each call smart-add for the same
   * term and race — the server's duplicate check can pass both, storing the word twice.
   * The second press waits here instead, then finds the id the first one learned and
   * only has group membership left to write. A ref, not state: it coordinates callbacks
   * that run outside the render flow and must never trigger one.
   */
  const createChain = useRef(new Map<string, Promise<void>>());

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
          items = items.map((i) => {
            if (i.kind !== "word" || i.status !== "queued") return i;
            const wordId = existing[i.term.trim()];
            if (!wordId) return i;
            const base = { ...i, existingWordId: wordId } as ImportItem;
            // The write died with the tab that started it, but `check-terms` proves it
            // landed — so every destination still marked in flight is settled, not just
            // the row summary. A row left spinning would keep its button disabled.
            const stillPending = pendingTargets(base);
            if (stillPending.length === 0) return { ...base, status: "registered" as const };
            return stillPending.reduce<ImportItem>(
              (acc, d) => withRegistration(acc, d, { status: "registered" }),
              base
            );
          });
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

  /**
   * Set one destination's registration state, always `immediate`.
   *
   * Goes through `withRegistration` so the row-level `status`/`target`/`error` summary
   * is re-derived in the same update — everything downstream (`isLocked`, the progress
   * counter, the load-time reconciliation, the backend's `registeredCount`) still reads
   * that triple, and it must never drift from the per-destination record it summarizes.
   */
  const patchRegistration = useCallback(
    (id: string, target: "A" | "B", state: ImportRegistrationState) => {
      setItems(
        (items) => items.map((i) => (i.id === id ? withRegistration(i, target, state) : i)),
        true
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
    (id: string, destination: "A" | "B", result: SettleResult) => {
      setItems((items) => {
        const target = items.find((i) => i.id === id);
        if (!target) return items;
        const key = itemKey(target);
        const idField = target.kind === "word" ? "existingWordId" : "existingGrammarId";
        // Recorded against `destination` alone, so a failed Group B write never puts the
        // ✗ on the Group A button — which may have succeeded a minute earlier, or may
        // still be in flight beside it.
        const terminal = result.ok
          ? { status: "registered" as const, error: undefined }
          : result.duplicate
          ? { status: "duplicate" as const, error: undefined }
          : { status: "failed" as const, error: result.error };

        return items.map((i) => {
          const learnedId =
            result.ok && result.entityId ? { [idField]: result.entityId } : {};
          if (i.id === id) {
            // Only the row that actually attempted the write can claim the rescue.
            return withRegistration({ ...i, ...learnedId } as ImportItem, destination, {
              ...terminal,
              ...(result.ok ? {} : { rescuedAsDraft: result.rescuedAsDraft }),
            });
          }
          if (!isLive(i) || i.kind !== target.kind || itemKey(i) !== key) return i;
          const withId = { ...i, ...learnedId } as ImportItem;
          // Only a sibling parked by the piggyback guard for THIS destination is waiting
          // on this outcome. One parked for the other destination has its own write.
          return i.registrations?.[destination]?.status === "queued"
            ? withRegistration(withId, destination, terminal)
            : withId;
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

  /**
   * Hands ONE item to the shared add queue for ONE destination and records its real
   * outcome. A row is registered into its Group A destination and its Group B
   * destination by two separate presses, so this is called once per destination.
   */
  const registerItem = useCallback(
    async (id: string, target: "A" | "B" = "A") => {
      const current = sessionRef.current;
      const started = current?.items.find((i) => i.id === id);
      // Refused only for THIS destination: Group A and Group B are separate writes, so a
      // press for one must not be swallowed while the other is running — that is what
      // made the second button dead until the first finished. NOT `isLocked` either,
      // which covers `registered`: a row already in Group A must still accept a Group B
      // press. `isLocked` stays the rule for EDITING the row's text.
      if (!current || !started || started.status === "skipped") return;
      if (started.registrations?.[target]?.status === "queued") return;
      const key = itemKey(started);
      if (!key) return;

      // An identical row already in flight for the SAME destination will settle this
      // one through sibling propagation. Enqueueing a second write for the same term
      // would race the first (the queue runs 4 at a time) and at best come back 409 —
      // which skips the group work entirely. A press for the OTHER destination has to
      // go through, since the leader is not writing those groups.
      // Read from the entry snapshot, so this call never sees the `queued` it is about
      // to set on itself.
      const piggyback = current.items.some(
        (i) =>
          i.id !== id &&
          isLive(i) &&
          i.registrations?.[target]?.status === "queued" &&
          i.kind === started.kind &&
          itemKey(i) === key
      );

      // In flight before any await, so the button spins immediately and a second press
      // for the same destination is refused by the guard above.
      patchRegistration(id, target, { status: "queued" });
      if (piggyback) return;

      /**
       * Wait for any CREATE already running for this term — from this row's other
       * destination or from a sibling row.
       *
       * This is what makes the two buttons safe to press together. Both presses on a row
       * whose entity does not exist yet would otherwise each call smart-add for the same
       * term; the two race, and the server's duplicate check can let both through, which
       * stores the word twice. Waiting costs nothing and turns the second press into the
       * cheap group-add path, because by then the id has been learned.
       *
       * Group adds are set-based and idempotent, so they are NOT chained — only creates.
       */
      const chainKey = `${started.kind} ${key}`;
      const runningCreate = createChain.current.get(chainKey);
      if (runningCreate) await runningCreate;

      // Re-read after the await: the create may have learned the entity id, and the row
      // may have been settled by sibling propagation or deleted while we waited.
      const session = sessionRef.current;
      const item = session?.items.find((i) => i.id === id);
      if (!session || !item || item.status === "skipped") return;
      if (item.registrations?.[target]?.status !== "queued") return;

      // Released when this call's own create settles; a no-op for the group-add paths,
      // which never claim the chain.
      let releaseCreate: (() => void) | undefined;
      const claimCreateChain = () => {
        const promise = new Promise<void>((resolve) => {
          releaseCreate = () => {
            if (createChain.current.get(chainKey) === promise) createChain.current.delete(chainKey);
            resolve();
          };
        });
        createChain.current.set(chainKey, promise);
      };

      const settle = (result: SettleResult) => {
        releaseCreate?.();
        applySettle(id, target, result);
      };
      const fail = (err: unknown) =>
        settle({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          duplicate: false,
          rescuedAsDraft: false,
        });

      /**
       * The groups THIS press writes.
       *
       * "A" writes the Group A destination alone. "B" writes the Group B set — plus
       * the Group A destination when the entity does not exist yet, because a Group B
       * group is the not-yet-memorized SUBSET of Group A rather than an independent
       * set: an item created into B alone would be missing from the browse lists and
       * from every Group A quiz. An item already in the library is left where it is,
       * so pressing B never moves a word out of the lesson group it belongs to.
       *
       * Resolving the B side only for a B press also matters: `groupBIdsFor` CREATES
       * the missing half of a Group B study set, and an A press has no business
       * materializing one.
       */
      const aGroupId = item.kind === "word" ? current.wordGroupId : current.grammarGroupId;
      const alreadyInLibrary = Boolean(
        item.kind === "word" ? item.existingWordId : item.existingGrammarId
      );
      let groupBIds: string[] = [];
      if (target === "B") {
        try {
          groupBIds = await groupBIdsFor(item.kind);
        } catch (err) {
          fail(err);
          return;
        }
      }
      const groupIds = [
        ...new Set([
          ...(aGroupId && (target === "A" || !alreadyInLibrary) ? [aGroupId] : []),
          ...groupBIds,
        ]),
      ];

      if (item.kind === "word") {
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
        // A throw here would leave the chain claimed and every later press for this term
        // waiting on a promise nobody will resolve, so `fail` (which releases it) has to
        // cover the enqueue itself, not just the queue's own outcome.
        try {
          claimCreateChain();
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
        } catch (err) {
          fail(err);
        }
        return;
      }

      const sentence = sentenceText(item.sentenceIndex);

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

      try {
        claimCreateChain();
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
      } catch (err) {
        fail(err);
      }
    },
    [
      applySettle,
      descriptionLanguage,
      groupBIdsFor,
      language,
      onGrammarQueue,
      onQueue,
      patchRegistration,
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
