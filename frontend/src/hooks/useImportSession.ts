import { useCallback, useEffect, useRef, useState } from "react";
import {
  createImportSession,
  getImportSession,
  updateImportSession,
} from "../api/import";
import { checkTerms, modifyGroupMembers } from "../api/vocab";
import { resolveGroupBTargets } from "../utils/groupB";
import { flattenSentences, isLocked } from "../utils/importSession";
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
}

export function useImportSession({
  language,
  onQueue,
  onGrammarQueue,
  descriptionLanguage,
}: Options) {
  const [session, setSessionState] = useState<ImportSession | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

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

  /** Hands ONE item to the shared add queue and records its real outcome. */
  const registerItem = useCallback(
    async (id: string) => {
      const current = sessionRef.current;
      const item = current?.items.find((i) => i.id === id);
      if (!current || !item || isLocked(item)) return;
      if (item.kind === "word" ? !item.term.trim() : !item.statement.trim()) return;

      patchItem(id, { status: "queued", error: undefined, rescuedAsDraft: undefined }, true);

      const settle = (
        result:
          | { ok: true }
          | { ok: false; error: string; duplicate: boolean; rescuedAsDraft: boolean }
      ) => {
        patchItem(
          id,
          result.ok
            ? { status: "registered", error: undefined }
            : result.duplicate
            ? { status: "duplicate", error: undefined }
            : { status: "failed", error: result.error, rescuedAsDraft: result.rescuedAsDraft },
          true
        );
      };

      let groupBIds: string[];
      try {
        groupBIds = await groupBIdsFor(item.kind);
      } catch (err) {
        settle({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          duplicate: false,
          rescuedAsDraft: false,
        });
        return;
      }

      if (item.kind === "word") {
        const groupIds = [
          ...new Set([...(current.wordGroupId ? [current.wordGroupId] : []), ...groupBIds]),
        ];
        if (item.existingWordId) {
          // Already in the DB: never re-created, only given group membership.
          try {
            await Promise.all(
              groupIds.map((gid) =>
                modifyGroupMembers(language, gid, [item.existingWordId!], "add")
              )
            );
            settle({ ok: true });
          } catch (err) {
            settle({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              duplicate: false,
              rescuedAsDraft: false,
            });
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
            ...(sentence ? { examples: [{ sentence, translation: "" }] } : {}),
            ...(groupIds.length > 0 ? { groupIds } : {}),
          },
          { onSettled: settle }
        );
        return;
      }

      const sentence = sentenceText(item.sentenceIndex);
      const groupIds = [
        ...new Set([...(current.grammarGroupId ? [current.grammarGroupId] : []), ...groupBIds]),
      ];
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
        { ...(groupIds.length > 0 ? { groupIds } : {}), onSettled: settle }
      );
    },
    [descriptionLanguage, groupBIdsFor, language, onGrammarQueue, onQueue, patchItem, sentenceText]
  );

  return {
    session,
    saveStatus,
    saveError,
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
