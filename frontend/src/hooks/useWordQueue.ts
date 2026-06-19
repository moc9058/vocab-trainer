import { useState, useEffect, useCallback, useMemo } from "react";
import { modifyGroupMembers, smartAddWord, updateWord } from "../api/vocab";
import type { Word } from "../types";

type SmartAddPayload = Parameters<typeof smartAddWord>[1];

// Maximum concurrent queue item executions. Higher = faster bulk adds,
// but raises the risk that two parallel adds touching the same example
// sentence write segment.id forward-links last-writer-wins. Reverse links
// (Word.appearsInIds) remain correct via arrayUnion; run syncSegmentLinks
// after a heavy batch if you spot a gap.
const CONCURRENCY = 4;

type QueueItem =
  | { id: string; type: "create"; term: string; language: string; payload: SmartAddPayload }
  | { id: string; type: "update"; term: string; language: string; wordId: string; updates: Partial<Word>; groupsToAdd: string[]; groupsToRemove: string[] };

export interface QueueResult {
  id: string;
  term: string;
  success: boolean;
  error?: string;
}

async function processItem(item: QueueItem): Promise<void> {
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
  } else {
    await updateWord(item.language, item.wordId, item.updates);
    await Promise.all([
      ...item.groupsToAdd.map((gid) => modifyGroupMembers(item.language, gid, [item.wordId], "add")),
      ...item.groupsToRemove.map((gid) => modifyGroupMembers(item.language, gid, [item.wordId], "remove")),
    ]);
  }
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
        .then(() => {
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
        })
        .finally(() => {
          setProcessing((prev) => prev.filter((p) => p.id !== item.id));
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, queue]);

  const enqueue = useCallback((term: string, language: string, payload: SmartAddPayload) => {
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: "create", term, language, payload },
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

  return {
    enqueue,
    enqueueUpdate,
    pendingTerms,
    processingTerms,
    succeededTerms,
    queueLength: queue.length,
    activeCount: processing.length,
    recentResults,
    clearResults,
    refreshSignal,
  };
}
