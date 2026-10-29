import { apiFetch, apiPollingOnly } from "../api/transport";
import type { EventConnection } from "../api/sse";
import { useCallback, useEffect, useRef, useState } from 'react';
import { getImportAnalysisJob, startImportAnalysisJob, pauseImportAnalysisJob, getImportSession, openImportAnalysisEvents } from '../api/import';
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
    let busy = false, finished = false, failures = 0;
    let source: EventConnection | null = null, streamHealthy = false, streamRetryAt = 0, lastEventAt = 0;
    let latest: ImportAnalysisJobSummary | null = null, sessionKey = '';
    let deliveries = Promise.resolve();
    const started = Date.now();
    function closeStream() { source?.close(); source = null; streamHealthy = false; }
    function failed(err: unknown, phase: string) {
      if (controller.signal.aborted || finished) return;
      if (err instanceof ApiError && [400, 401, 403, 404, 409, 410, 413].includes(err.status)) {
        finished = true; closeStream(); setError(err.message); setReconnecting(false);
      } else {
        failures++; setReconnecting(true);
        if (Date.now() - diagnosticsAt.current > 60_000) {
          diagnosticsAt.current = Date.now();
          void apiFetch('/api/import/analysis-diagnostics', { method: 'POST', credentials: CREDENTIALS, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: target!.id, phase, elapsedMs: Date.now() - started, online: navigator.onLine, visibility: document.visibilityState, errorName: err instanceof Error ? err.name.slice(0, 40) : 'Unknown' }) }).catch(() => {});
        }
      }
    }
    function accept(current: ImportAnalysisJobSummary) {
      deliveries = deliveries.then(async () => {
        if (finished || controller.signal.aborted) return;
        // A GET already in flight may arrive after a newer SSE snapshot.
        if (latest && (current.generation < latest.generation ||
          (current.generation === latest.generation && (current.revision < latest.revision ||
            (current.revision === latest.revision && (current.progress?.updatedAt ?? '') < (latest.progress?.updatedAt ?? '')))))) return;
        latest = current; setJob(current);
        const terminal = !['queued', 'running'].includes(current.state);
        const key = `${current.generation}:${current.nextBatch}:${terminal ? current.revision : 'active'}`;
        if (sessionKey !== key) {
          const session = await getImportSession(language, target!.id, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
          controller.signal.throwIfAborted(); callbacks.current.onSession(session); sessionKey = key;
        }
        setReconnecting(false); setError(null); failures = 0;
        if (terminal) { finished = true; closeStream(); callbacks.current.onSettled(current); }
      }).catch(err => failed(err, 'session'));
      return deliveries;
    }
    function connect() {
      if (apiPollingOnly() || source || finished || controller.signal.aborted || document.hidden || Date.now() < streamRetryAt || typeof EventSource === 'undefined') return;
      try {
        const connection = openImportAnalysisEvents(language, target!.id); source = connection;
        connection.onopen = () => { if (source === connection) { streamHealthy = true; lastEventAt = Date.now(); } };
        connection.onmessage = event => {
          if (source !== connection) return;
          lastEventAt = Date.now(); streamHealthy = true;
          try { void accept(JSON.parse(event.data) as ImportAnalysisJobSummary); }
          catch { closeStream(); streamRetryAt = Date.now() + 30_000; }
        };
        connection.onerror = () => {
          if (source !== connection) return;
          closeStream(); streamRetryAt = Date.now() + 30_000;
          // GET handles auth errors and transport diagnostics using the existing API path.
          void poll();
        };
      } catch { closeStream(); streamRetryAt = Date.now() + 30_000; }
    }
    async function poll() {
      if (busy || finished || controller.signal.aborted || (apiPollingOnly() && document.hidden)) return;
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
        await accept(current); connect();
      } catch (err) { failed(err, phase); }
      finally {
        busy = false;
        if (!finished && !controller.signal.aborted) timer = setTimeout(() => void poll(),
          (failures ? Math.min(15_000, 3000 * 2 ** Math.min(failures, 3)) :
            document.hidden || (streamHealthy && Date.now() - lastEventAt < 25_000) ? 10_000 : 3000) + (apiPollingOnly() ? Math.floor(Math.random() * 1000) : 0));
      }
    }
    const wake = () => {
      if (document.hidden) { closeStream(); return; }
      if (navigator.onLine) { streamRetryAt = 0; void poll(); }
    };
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    void poll();
    return () => { controller.abort(); closeStream(); if (timer) clearTimeout(timer); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [target, language]);
  const pause = useCallback(async () => {
    if (!target) return;
    try { setJob(await pauseImportAnalysisJob(language, target.id, crypto.randomUUID())); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [target, language]);
  return { job, reconnecting, error, watch, stop, pause };
}
