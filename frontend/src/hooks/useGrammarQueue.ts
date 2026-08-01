import { useState, useEffect, useCallback, useMemo } from "react";
import {
  smartAddGrammarItem,
  updateGrammarItem,
  modifyGrammarGroupMembers,
  getGrammarGroups,
  createGrammarGroup,
  deleteGrammarDraft,
  uploadGrammarDrafts,
} from "../api/grammar";
import type { Grammar, GrammarDraft } from "../types";

type GrammarPayload = Omit<Grammar, "language">;

/** Extra work a `create` item performs after a successful smart-add — used by
 *  draft registration so the review modal can close immediately. */
export interface GrammarCreateOptions {
  /** Group NAMES to attach the new item to; missing groups are created. */
  groupNames?: string[];
  /** Existing group IDs to attach the new item to (mirrors the word queue's
   *  `payload.groupIds`). Used by the Group B selector, which always knows IDs. */
  groupIds?: string[];
  /** Draft to delete once the item (and its groups) are fully registered. */
  draftId?: string;
  /**
   * Per-item outcome, for callers that must report the fate of ONE enqueued item
   * (the article importer). Mirrors `WordCreateOptions.onSettled`; `pendingTerms`
   * and the capped `recentResults` cannot serve that purpose. Held in queue state
   * only — never serialized.
   */
  onSettled?: (
    result:
      | {
          ok: true;
          /** The grammar item that was created — the server-confirmed ID, not the
           *  client-generated one in the payload. Reported for the same reason the
           *  word queue reports `wordId`: the caller needs it to say anything about
           *  the item's group membership without a second round trip. */
          grammarId?: string;
        }
      | {
          ok: false;
          error: string;
          duplicate: boolean;
          rescuedAsDraft: boolean;
          /** Set when the item WAS created and only follow-up work — group
           *  attach / draft retirement — failed (mirrors the word queue's
           *  `wordId` on the failure arm). */
          grammarId?: string;
        }
  ) => void;
}

const CONCURRENCY = 4;

type QueueItem =
  | { id: string; type: "create"; statement: string; language: string; payload: GrammarPayload; groupNames?: string[]; groupIds?: string[]; draftId?: string; onSettled?: GrammarCreateOptions["onSettled"] }
  | { id: string; type: "update"; statement: string; language: string; grammarId: string; updates: Partial<Grammar>; groupsToAdd: string[]; groupsToRemove: string[] };

export interface GrammarQueueResult {
  id: string;
  statement: string;
  success: boolean;
  error?: string;
}

// A create that got PAST smart-add: the item exists in the DB, only follow-up
// work (group attach, draft retirement) failed — must not be rescued as a
// draft, which would store the pattern twice on the next registration (grammar
// smart-add has no server-side duplicate check).
class PostCreateError extends Error {
  constructor(public grammarId: string, public cause: unknown) {
    super(String(cause));
  }
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

/** Resolves to the created item's ID for a `create`, and to undefined for an `update`. */
async function processItem(item: QueueItem): Promise<string | undefined> {
  if (item.type === "create") {
    // No 409 recovery here, unlike the word queue: grammar smart-add has no
    // server-side duplicate check, so a 409 is unreachable.
    const saved = await smartAddGrammarItem(item.language, item.payload);
    try {
      if (item.groupIds && item.groupIds.length > 0) {
        await Promise.all(
          item.groupIds.map((groupId) =>
            modifyGrammarGroupMembers(item.language, groupId, [saved.id], "add"),
          ),
        );
      }
      // `item.groupNames` already reflects the caller's full intent — the form's
      // selected-groups checkboxes (defaulted to the latest group unless the
      // user changed them) plus any not-yet-existing draft group names.
      if (item.groupNames && item.groupNames.length > 0) {
        const names = [...new Set(item.groupNames.map((n) => n.trim()).filter(Boolean))];
        await withGroupLock(async () => {
          const existing = await getGrammarGroups(item.language);
          for (const name of names) {
            const group =
              existing.find((g) => g.name === name) ??
              (await createGrammarGroup(item.language, name));
            await modifyGrammarGroupMembers(item.language, group.id, [saved.id], "add");
          }
        });
      }
      // Retire the source draft only after the item and its groups all succeeded,
      // so a failed registration keeps the draft available for another attempt.
      if (item.draftId) {
        await deleteGrammarDraft(item.language, item.draftId);
      }
    } catch (err) {
      throw new PostCreateError(saved.id, err);
    }
    return saved.id;
  }
  await updateGrammarItem(item.language, item.grammarId, item.updates);
  await Promise.all([
    ...item.groupsToAdd.map((gid) => modifyGrammarGroupMembers(item.language, gid, [item.grammarId], "add")),
    ...item.groupsToRemove.map((gid) => modifyGrammarGroupMembers(item.language, gid, [item.grammarId], "remove")),
  ]);
  return undefined;
}

/** Re-insert the user's chip splits as spaces so the Chinese segmentation
 *  survives the draft round-trip (draft review re-derives splits from spaces). */
function respaceByUserSplits(sentence: string, splits?: string[]): string {
  if (!splits || splits.length < 2) return sentence;
  let out = "";
  let cursor = 0;
  for (const split of splits) {
    const idx = sentence.indexOf(split, cursor);
    if (idx === -1) return sentence;
    out += sentence.slice(cursor, idx) + split + " ";
    cursor = idx + split.length;
  }
  out += sentence.slice(cursor);
  return out.trimEnd();
}

// A failed create would silently lose the user's input, so it is preserved as a
// grammar draft for review/retry. Drafts no longer carry group targets — the
// group is chosen again at registration time. Draft-originated items never reach
// this: their source draft is only deleted on success and thus still exists.
async function saveFailedCreateAsDraft(
  item: Extract<QueueItem, { type: "create" }>,
): Promise<void> {
  const p = item.payload;
  const draft: Omit<GrammarDraft, "id" | "language" | "createdAt"> = {
    statement: p.statement,
    ...(p.transliteration ? { transliteration: p.transliteration } : {}),
    descriptions: p.descriptions ?? [],
    ...(p.examples?.length
      ? {
          examples: p.examples.map(({ userSplits, ...ex }) => ({
            ...ex,
            sentence: respaceByUserSplits(ex.sentence, userSplits),
          })),
        }
      : {}),
    ...(p.level ? { level: p.level } : {}),
    ...(p.tags?.length ? { tags: p.tags } : {}),
  };
  await uploadGrammarDrafts(item.language, [draft]);
}

export function useGrammarQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [processing, setProcessing] = useState<QueueItem[]>([]);
  const [recentResults, setRecentResults] = useState<GrammarQueueResult[]>([]);
  const [refreshSignal, setRefreshSignal] = useState(0);

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
        .then((grammarId) => {
          if (item.type === "create") item.onSettled?.({ ok: true, grammarId });
          setRecentResults((prev) =>
            [{ id: item.id, statement: item.statement, success: true }, ...prev].slice(0, 5),
          );
          setRefreshSignal((s) => s + 1);
        })
        .catch((err: unknown) => {
          if (item.type === "create" && err instanceof PostCreateError) {
            // The item IS stored — only group attach / draft retirement failed.
            // No draft rescue (registering the rescue would store the pattern
            // twice). The failure settle carries the id so callers (the
            // importer) can retry down the idempotent group-add path.
            setRecentResults((prev) =>
              [{
                id: item.id,
                statement: item.statement,
                success: false,
                error: `created, but follow-up failed: ${String(err.cause)}`,
              }, ...prev].slice(0, 5),
            );
            item.onSettled?.({
              ok: false,
              error: String(err.cause),
              duplicate: false,
              rescuedAsDraft: false,
              grammarId: err.grammarId,
            });
            setRefreshSignal((s) => s + 1);
            return;
          }
          setRecentResults((prev) =>
            [{ id: item.id, statement: item.statement, success: false, error: String(err) }, ...prev].slice(0, 5),
          );
          // Rescue failed creates into a draft — except 409 duplicates and
          // draft-originated items (their source draft still exists).
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

  const enqueue = useCallback((statement: string, language: string, payload: GrammarPayload, opts?: GrammarCreateOptions) => {
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: "create", statement, language, payload, ...(opts ?? {}) },
    ]);
  }, []);

  const enqueueUpdate = useCallback((
    statement: string,
    language: string,
    grammarId: string,
    updates: Partial<Grammar>,
    groupsToAdd: string[],
    groupsToRemove: string[],
  ) => {
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: "update", statement, language, grammarId, updates, groupsToAdd, groupsToRemove },
    ]);
  }, []);

  const clearResults = useCallback(() => setRecentResults([]), []);

  const pendingTerms = useMemo(() => {
    const s = new Set<string>();
    for (const item of processing) s.add(item.statement);
    for (const item of queue) s.add(item.statement);
    return s;
  }, [processing, queue]);

  const processingTerms = useMemo(() => {
    const s = new Set<string>();
    for (const item of processing) s.add(item.statement);
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
    pendingDraftIds,
    queueLength: queue.length,
    activeCount: processing.length,
    recentResults,
    clearResults,
    refreshSignal,
  };
}
