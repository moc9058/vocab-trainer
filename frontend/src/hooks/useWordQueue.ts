import { useState, useEffect, useCallback, useMemo } from "react";
import { modifyGroupMembers, smartAddWord } from "../api/vocab";

type SmartAddPayload = Parameters<typeof smartAddWord>[1];

// Maximum smartAddWord calls in flight at once. Higher = faster bulk adds,
// but raises the risk that two parallel adds touching the same example
// sentence write segment.id forward-links last-writer-wins. Reverse links
// (Word.appearsInIds) remain correct via arrayUnion; run syncSegmentLinks
// after a heavy batch if you spot a gap.
const CONCURRENCY = 4;

interface QueueItem {
  id: string;
  term: string;
  language: string;
  payload: SmartAddPayload;
}

export interface QueueResult {
  id: string;
  term: string;
  success: boolean;
  error?: string;
}

export function useWordQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [processing, setProcessing] = useState<QueueItem[]>([]);
  const [recentResults, setRecentResults] = useState<QueueResult[]>([]);
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
      smartAddWord(item.language, item.payload)
        .then(async (word) => {
          const groupIds = item.payload.groupIds ?? [];
          if (groupIds.length > 0) {
            await Promise.all(
              groupIds.map((groupId) =>
                modifyGroupMembers(item.language, groupId, [word.id], "add"),
              ),
            );
          }
          setRecentResults((prev) =>
            [{ id: item.id, term: item.term, success: true }, ...prev].slice(0, 5),
          );
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
      { id: crypto.randomUUID(), term, language, payload },
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
    pendingTerms,
    processingTerms,
    queueLength: queue.length,
    activeCount: processing.length,
    recentResults,
    clearResults,
    refreshSignal,
  };
}
