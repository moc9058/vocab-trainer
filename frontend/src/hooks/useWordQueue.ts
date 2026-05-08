import { useState, useEffect, useCallback, useRef } from "react";
import { smartAddWord } from "../api/vocab";

type SmartAddPayload = Parameters<typeof smartAddWord>[1];

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
  const [processing, setProcessing] = useState<QueueItem | null>(null);
  const [recentResults, setRecentResults] = useState<QueueResult[]>([]);
  const [refreshSignal, setRefreshSignal] = useState(0);
  // Keep a ref to processing so the effect closure always sees the latest value
  const processingRef = useRef<QueueItem | null>(null);

  useEffect(() => {
    processingRef.current = processing;
  }, [processing]);

  useEffect(() => {
    if (processing !== null || queue.length === 0) return;

    const [next, ...rest] = queue;
    setQueue(rest);
    setProcessing(next);

    smartAddWord(next.language, next.payload)
      .then(() => {
        setRecentResults((prev) =>
          [{ id: next.id, term: next.term, success: true }, ...prev].slice(0, 5)
        );
        setRefreshSignal((s) => s + 1);
      })
      .catch((err: unknown) => {
        setRecentResults((prev) =>
          [{ id: next.id, term: next.term, success: false, error: String(err) }, ...prev].slice(0, 5)
        );
      })
      .finally(() => {
        setProcessing(null);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, queue]);

  const enqueue = useCallback((term: string, language: string, payload: SmartAddPayload) => {
    setQueue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), term, language, payload },
    ]);
  }, []);

  const clearResults = useCallback(() => setRecentResults([]), []);

  return {
    enqueue,
    queueLength: queue.length,
    processingTerm: processing?.term ?? null,
    recentResults,
    clearResults,
    refreshSignal,
  };
}
