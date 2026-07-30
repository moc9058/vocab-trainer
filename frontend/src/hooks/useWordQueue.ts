import { useState, useEffect, useCallback, useMemo } from "react";
import {
  modifyGroupMembers,
  smartAddWord,
  updateWord,
  getGroups,
  createGroup,
  uploadWordDrafts,
  deleteWordDraft,
} from "../api/vocab";
import type { Word, WordDraft } from "../types";

type SmartAddPayload = Parameters<typeof smartAddWord>[1];

/** Extra work a `create` item performs after a successful smart-add — used by
 *  draft registration so the review modal can close immediately. */
export interface WordCreateOptions {
  /** Group NAMES to attach the new word to; missing groups are created. */
  groupNames?: string[];
  /** Draft to delete once the word (and its groups) are fully registered. */
  draftId?: string;
  /**
   * Per-item outcome, for callers that must report the fate of ONE enqueued item
   * (the article importer). `succeededTerms` cannot serve this: it is keyed by term
   * string, so two rows sharing a term are indistinguishable, it is success-only,
   * and it lives in memory so it cannot survive the reload. Held in queue state
   * only — never serialized.
   */
  onSettled?: (
    result:
      | {
          ok: true;
          /** The word that was created. Reported because `processItem` already holds
           *  it — without this the caller has to rediscover the ID with a
           *  `check-terms` round trip before it can say anything about the word's
           *  group membership. */
          wordId?: string;
        }
      | { ok: false; error: string; duplicate: boolean; rescuedAsDraft: boolean }
  ) => void;
}

// Maximum concurrent queue item executions. Higher = faster bulk adds,
// but raises the risk that two parallel adds touching the same example
// sentence write segment.id forward-links last-writer-wins. Reverse links
// (Word.appearsInIds) remain correct via arrayUnion; run syncSegmentLinks
// after a heavy batch if you spot a gap.
const CONCURRENCY = 4;

type QueueItem =
  | { id: string; type: "create"; term: string; language: string; payload: SmartAddPayload; groupNames?: string[]; draftId?: string; onSettled?: WordCreateOptions["onSettled"] }
  | { id: string; type: "update"; term: string; language: string; wordId: string; updates: Partial<Word>; groupsToAdd: string[]; groupsToRemove: string[] };

export interface QueueResult {
  id: string;
  term: string;
  success: boolean;
  error?: string;
}

// Serializes group-by-NAME resolution across the parallel workers: two queued
// drafts sharing a brand-new group name would otherwise both miss the lookup
// and each create a duplicate group.
let groupOpsChain: Promise<void> = Promise.resolve();
function withGroupLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = groupOpsChain.then(fn);
  groupOpsChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Resolves to the created word's ID for a `create`, and to undefined for an `update`. */
async function processItem(item: QueueItem): Promise<string | undefined> {
  if (item.type === "create") {
    const word = await smartAddWord(item.language, item.payload);
    const groupIds = item.payload.groupIds ?? [];
    if (groupIds.length > 0) {
      await Promise.all(
        groupIds.map((groupId) =>
          modifyGroupMembers(item.language, groupId, [word.id], "add"),
        ),
      );
    }
    if (item.groupNames && item.groupNames.length > 0) {
      const names = [...new Set(item.groupNames.map((n) => n.trim()).filter(Boolean))];
      await withGroupLock(async () => {
        const existing = await getGroups(item.language);
        for (const name of names) {
          const group =
            existing.find((g) => g.name === name) ??
            (await createGroup(item.language, name));
          await modifyGroupMembers(item.language, group.id, [word.id], "add");
        }
      });
    }
    // Retire the source draft only after the word and its groups all succeeded,
    // so a failed registration keeps the draft available for another attempt.
    if (item.draftId) {
      await deleteWordDraft(item.language, item.draftId);
    }
    return word.id;
  }
  await updateWord(item.language, item.wordId, item.updates);
  await Promise.all([
    ...item.groupsToAdd.map((gid) => modifyGroupMembers(item.language, gid, [item.wordId], "add")),
    ...item.groupsToRemove.map((gid) => modifyGroupMembers(item.language, gid, [item.wordId], "remove")),
  ]);
  return undefined;
}

// A failed create would silently lose the user's input (segment-chip adds have
// no other record), so it is preserved as a word draft for review/retry. Draft
// examples carry the chip segmentation as `segments` (plain segment texts) so
// the review modal restores the splits. Drafts no longer carry group targets —
// the group is chosen again at registration time. Draft-originated items never
// reach this: their source draft is only deleted on success and thus still exists.
async function saveFailedCreateAsDraft(
  item: Extract<QueueItem, { type: "create" }>,
): Promise<void> {
  const p = item.payload;
  const draft: Omit<WordDraft, "id" | "language" | "createdAt"> = {
    term: p.term,
    ...(p.transliteration ? { transliteration: p.transliteration } : {}),
    ...(p.definitions?.length ? { definitions: p.definitions } : {}),
    ...(p.examples?.length
      ? {
          examples: p.examples.map((ex) => ({
            sentence: ex.sentence,
            translation: ex.translation,
            ...(ex.userSplits && ex.userSplits.length >= 2 ? { segments: ex.userSplits } : {}),
          })),
        }
      : {}),
    ...(p.level ? { level: p.level } : {}),
    ...(p.topics?.length ? { topics: p.topics } : {}),
  };
  await uploadWordDrafts(item.language, [draft]);
}

export function useWordQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [processing, setProcessing] = useState<QueueItem[]>([]);
  const [recentResults, setRecentResults] = useState<QueueResult[]>([]);
  const [refreshSignal, setRefreshSignal] = useState(0);
  // Cumulative set of terms whose add/update has succeeded this session. This is
  // the authoritative "now in the DB" signal consumers (segment chips) use to
  // flip a word from "generating" → "added" the instant the queue finishes —
  // no DB re-poll required. Monotonic, so a confirmed chip can never revert.
  const [succeededTerms, setSucceededTerms] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (queue.length === 0) return;
    if (processing.length >= CONCURRENCY) return;
    const slots = CONCURRENCY - processing.length;
    const toStart = queue.slice(0, slots);
    if (toStart.length === 0) return;

    setQueue((prev) => prev.slice(toStart.length));
    setProcessing((prev) => [...prev, ...toStart]);

    for (const item of toStart) {
      processItem(item)
        .then((wordId) => {
          if (item.type === "create") item.onSettled?.({ ok: true, wordId });
          setRecentResults((prev) =>
            [{ id: item.id, term: item.term, success: true }, ...prev].slice(0, 5),
          );
          setSucceededTerms((prev) => new Set(prev).add(item.term));
          setRefreshSignal((s) => s + 1);
        })
        .catch((err: unknown) => {
          setRecentResults((prev) =>
            [{ id: item.id, term: item.term, success: false, error: String(err) }, ...prev].slice(0, 5),
          );
          // Rescue failed creates into a draft — except 409 duplicates (the word
          // is already in the DB) and draft-originated items (draft still exists).
          if (item.type !== "create") return;
          const duplicate = String(err).includes("409");
          const settle = (rescuedAsDraft: boolean) =>
            item.onSettled?.({ ok: false, error: String(err), duplicate, rescuedAsDraft });
          if (!item.draftId && !duplicate) {
            // Settle only once the rescue resolves, so `rescuedAsDraft` is accurate.
            saveFailedCreateAsDraft(item)
              .then(() => {
                setRefreshSignal((s) => s + 1);
                settle(true);
              })
              .catch(() => settle(false));
          } else {
            settle(false);
          }
        })
        .finally(() => {
          setProcessing((prev) => prev.filter((p) => p.id !== item.id));
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, queue]);

  const enqueue = useCallback((term: string, language: string, payload: SmartAddPayload, opts?: WordCreateOptions) => {
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: "create", term, language, payload, ...(opts ?? {}) },
    ]);
  }, []);

  const enqueueUpdate = useCallback((
    term: string,
    language: string,
    wordId: string,
    updates: Partial<Word>,
    groupsToAdd: string[],
    groupsToRemove: string[],
  ) => {
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: "update", term, language, wordId, updates, groupsToAdd, groupsToRemove },
    ]);
  }, []);

  const clearResults = useCallback(() => setRecentResults([]), []);

  const pendingTerms = useMemo(() => {
    const s = new Set<string>();
    for (const item of processing) s.add(item.term);
    for (const item of queue) s.add(item.term);
    return s;
  }, [processing, queue]);

  const processingTerms = useMemo(() => {
    const s = new Set<string>();
    for (const item of processing) s.add(item.term);
    return s;
  }, [processing]);

  // Draft IDs whose registration is queued or in flight — drives the
  // "Registering…" badge on draft rows. Clears on success (draft deleted) AND
  // on failure (draft kept, actions re-enabled for another attempt).
  const pendingDraftIds = useMemo(() => {
    const s = new Set<string>();
    for (const item of [...processing, ...queue]) {
      if (item.type === "create" && item.draftId) s.add(item.draftId);
    }
    return s;
  }, [processing, queue]);

  return {
    enqueue,
    enqueueUpdate,
    pendingTerms,
    processingTerms,
    succeededTerms,
    pendingDraftIds,
    queueLength: queue.length,
    activeCount: processing.length,
    recentResults,
    clearResults,
    refreshSignal,
  };
}
