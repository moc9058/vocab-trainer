import { useState, useEffect, useCallback, useMemo } from "react";
import { smartAddGrammarItem, updateGrammarItem, modifyGrammarGroupMembers } from "../api/grammar";
import type { Grammar } from "../types";

type GrammarPayload = Omit<Grammar, "language">;

const CONCURRENCY = 4;

type QueueItem =
  | { id: string; type: "create"; statement: string; language: string; payload: GrammarPayload }
  | { id: string; type: "update"; statement: string; language: string; grammarId: string; updates: Partial<Grammar>; groupsToAdd: string[]; groupsToRemove: string[] };

export interface GrammarQueueResult {
  id: string;
  statement: string;
  success: boolean;
  error?: string;
}

async function processItem(item: QueueItem): Promise<void> {
  if (item.type === "create") {
    await smartAddGrammarItem(item.language, item.payload);
  } else {
    await updateGrammarItem(item.language, item.grammarId, item.updates);
    await Promise.all([
      ...item.groupsToAdd.map((gid) => modifyGrammarGroupMembers(item.language, gid, [item.grammarId], "add")),
      ...item.groupsToRemove.map((gid) => modifyGrammarGroupMembers(item.language, gid, [item.grammarId], "remove")),
    ]);
  }
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
        .then(() => {
          setRecentResults((prev) =>
            [{ id: item.id, statement: item.statement, success: true }, ...prev].slice(0, 5),
          );
          setRefreshSignal((s) => s + 1);
        })
        .catch((err: unknown) => {
          setRecentResults((prev) =>
            [{ id: item.id, statement: item.statement, success: false, error: String(err) }, ...prev].slice(0, 5),
          );
        })
        .finally(() => {
          setProcessing((prev) => prev.filter((p) => p.id !== item.id));
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, queue]);

  const enqueue = useCallback((statement: string, language: string, payload: GrammarPayload) => {
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: "create", statement, language, payload },
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

  return {
    enqueue,
    enqueueUpdate,
    pendingTerms,
    processingTerms,
    queueLength: queue.length,
    activeCount: processing.length,
    recentResults,
    clearResults,
    refreshSignal,
  };
}
