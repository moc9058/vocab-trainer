import { useCallback, useEffect, useRef, useState } from 'react';
import { getImportAnalysisJob, startImportAnalysisJob, pauseImportAnalysisJob, getImportSession } from '../api/import';
import { ApiError, CREDENTIALS } from '../api/client';
import type { ImportAnalysisJobSummary, ImportSession } from '../types';

/** Only monitors durable jobs. Aborting this hook never cancels a server job. */
export function useImportAnalysisJob(language: string, onSession: (s: ImportSession) => void, onSettled: (job: ImportAnalysisJobSummary) => void) {
  const [target, setTarget] = useState<{ id: string; ensure?: { key: string; revision: number } } | null>(null);
  const [job, setJob] = useState<ImportAnalysisJobSummary | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef({ onSession, onSettled }); callbacks.current = { onSession, onSettled };
  const diagnosticsAt = useRef(0);
  const stop = useCallback(() => { setTarget(null); setJob(null); setError(null); setReconnecting(false); }, []);
  const watch = useCallback((id: string, ensure?: { key: string; revision: number }) => {
    setError(null); setJob(null); setReconnecting(false); setTarget({ id, ensure });
  }, []);
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false, revision = -1, unchanged = 0, finished = false, failures = 0;
    const started = Date.now();
    async function poll() {
      if (busy || finished || controller.signal.aborted) return;
      if (timer) clearTimeout(timer);
      busy = true;
      let phase = 'poll';
      try {
        let current: ImportAnalysisJobSummary;
        try { current = await getImportAnalysisJob(language, target!.id, controller.signal); }
        catch (err) {
          if (err instanceof ApiError && err.status === 404 && err.code === 'IMPORT_JOB_NOT_FOUND' && target!.ensure) {
            phase = 'start';
            current = await startImportAnalysisJob(language, target!.id, target!.ensure!.key, target!.ensure!.revision, controller.signal);
          } else throw err;
        }
        controller.signal.throwIfAborted(); setJob(current);
        const terminal = !['queued', 'running'].includes(current.state);
        if (current.revision !== revision || terminal) {
          phase = 'session';
          const session = await getImportSession(language, target!.id, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
          controller.signal.throwIfAborted(); callbacks.current.onSession(session);
          revision = current.revision; unchanged = 0;
        } else unchanged++;
        setReconnecting(false); setError(null); failures = 0;
        if (terminal) { finished = true; callbacks.current.onSettled(current); }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && [400, 401, 403, 404, 409, 413].includes(err.status)) {
          finished = true; setError(err.message); setReconnecting(false);
        } else {
          failures++; setReconnecting(true);
          if (Date.now() - diagnosticsAt.current > 60_000) {
            diagnosticsAt.current = Date.now();
            void fetch('/api/import/analysis-diagnostics', { method: 'POST', credentials: CREDENTIALS, headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobId: target!.id, phase, elapsedMs: Date.now() - started, online: navigator.onLine, visibility: document.visibilityState, errorName: err instanceof Error ? err.name.slice(0, 40) : 'Unknown' }) }).catch(() => {});
          }
        }
      } finally {
        busy = false;
        if (!finished && !controller.signal.aborted) timer = setTimeout(() => void poll(),
          document.hidden || unchanged > 10 ? 10_000 : failures ? Math.min(15_000, 3000 * 2 ** Math.min(failures, 3)) : 3000);
      }
    }
    const wake = () => { if (!document.hidden && navigator.onLine) void poll(); };
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [target, language]);
  const pause = useCallback(async () => {
    if (!target) return;
    try { setJob(await pauseImportAnalysisJob(language, target.id, crypto.randomUUID())); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [target, language]);
  return { job, reconnecting, error, watch, stop, pause };
}
