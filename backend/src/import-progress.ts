import type { ImportAnalysisProgress } from './types.js';

/** Coalesce deltas and serialize best-effort writes; never persist model text. */
export function createProgressReporter(initial: ImportAnalysisProgress,
  persist: (progress: ImportAnalysisProgress) => Promise<void>, onError: () => void,
  intervalMs = 3000) {
  let progress = { ...initial }, dirty = false, stopped = false;
  let writes = Promise.resolve();
  function flush() {
    writes = writes.then(async () => {
      if (!dirty) return;
      const snapshot = { ...progress }; dirty = false;
      try { await persist(snapshot); } catch { onError(); }
    });
    return writes;
  }
  const timer = setInterval(() => { if (dirty) void flush(); }, intervalMs);
  timer.unref();
  return {
    receive(length: number) {
      if (stopped) return;
      const now = new Date().toISOString(), first = !progress.firstReceivedAt;
      progress = { ...progress, stage: 'generating', receivedCharacters: progress.receivedCharacters + length,
        firstReceivedAt: progress.firstReceivedAt ?? now, lastReceivedAt: now, updatedAt: now };
      dirty = true;
      if (first) void flush();
    },
    async stage(stage: ImportAnalysisProgress['stage']) {
      progress = { ...progress, stage, updatedAt: new Date().toISOString() }; dirty = true;
      await flush();
    },
    async stop() { stopped = true; clearInterval(timer); await flush(); },
  };
}
