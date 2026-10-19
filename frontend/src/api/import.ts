import { deleteRequest, fetchJson, postJson, putJson, CREDENTIALS, notifyIfUnauthorized } from "./client";
import type {
  ImportAnalysisJobSummary,
  ImportAnalysisResult,
  ImportReadingAnalysis,
  ImportQuizPool,
  ImportSession,
  ImportSessionSummary,
} from "../types";

// ----- Import sessions (paused, resumable article reviews) -----

type NewImportSession = Omit<ImportSession, "id" | "language" | "createdAt" | "updatedAt"> & { analyzeInParts?: boolean; analyzeAsJob?: boolean };

/** The list carries the article quizzes' `pool` alongside the summaries: the handler
 *  already reads every session document in full, so deriving it there costs nothing,
 *  whereas a second endpoint would re-read the same heavy docs on one screen load. */
export function listImportSessions(
  language: string
): Promise<{ sessions: ImportSessionSummary[]; pool: ImportQuizPool }> {
  return fetchJson(`/api/import/${encodeURIComponent(language)}/sessions`);
}

export function createImportSession(
  language: string,
  session: NewImportSession,
  signal?: AbortSignal
): Promise<ImportSession> {
  return postJson(`/api/import/${encodeURIComponent(language)}/sessions`, session, signal);
}

export function getImportSession(language: string, sessionId: string, signal?: AbortSignal): Promise<ImportSession> {
  return fetchJson(
    `/api/import/${encodeURIComponent(language)}/sessions/${encodeURIComponent(sessionId)}`, signal
  );
}

export function updateImportSession(
  language: string,
  sessionId: string,
  updates: Partial<NewImportSession> & { analysisCheckpoint?: number; analysisRevision?: number }
): Promise<ImportSession> {
  return putJson(
    `/api/import/${encodeURIComponent(language)}/sessions/${encodeURIComponent(sessionId)}`,
    updates
  );
}

export function deleteImportSession(language: string, sessionId: string): Promise<void> {
  return deleteRequest(
    `/api/import/${encodeURIComponent(language)}/sessions/${encodeURIComponent(sessionId)}`
  );
}

export interface AnalyzeImportCallbacks {
  onStart?: () => void;
  /** Partial (still-growing) raw JSON of the analysis — used for live rendering. */
  onDelta?: (text: string) => void;
  /** `existing` maps term → word ID, `existingGrammar` statement → grammar ID, for
   *  items already in the library. Both are the server's answer to "is this new?" */
  onResult?: (
    analysis: ImportAnalysisResult,
    existing: Record<string, string>,
    existingGrammar: Record<string, string>
  ) => void | Promise<void>;
  onDone?: () => void;
  onError?: (err: Error) => void;
}

/**
 * SSE-over-POST article analysis. Same reader loop as `api/translation.ts`'s
 * `translateStream`: the payload is far too large for an EventSource query string.
 */
export async function analyzeImportStream(
  language: string,
  text: string,
  callbacks: AnalyzeImportCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`/api/import/${encodeURIComponent(language)}/analyze-stream`, {
    method: "POST",
    credentials: CREDENTIALS,
    headers: { "Content-Type": "application/json" },
    // Old servers ignore this field and continue sending full analysis-delta frames.
    body: JSON.stringify({ text, streamFormat: "chunks" }),
    signal,
  });

  if (!res.ok) {
    notifyIfUnauthorized(res);
    throw new Error(`API error: ${res.status} ${res.statusText} ${await res.text()}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let terminated = false;
  let currentEvent = "";
  let accumulated = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith("event: ")) currentEvent = line.slice(7);
        else if (line.startsWith("data: ") && currentEvent) {
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { currentEvent = ""; continue; }
          const event = currentEvent;
          currentEvent = "";
          switch (event) {
            case "analysis-start": accumulated = ""; callbacks.onStart?.(); break;
            case "analysis-chunk": accumulated += data.chunk; callbacks.onDelta?.(accumulated); break;
            case "analysis-delta": accumulated = data.text; callbacks.onDelta?.(accumulated); break;
            case "analysis-result": await callbacks.onResult?.(data.analysis, data.existing ?? {}, data.existingGrammar ?? {}); break;
            case "done": terminated = true; callbacks.onDone?.(); return;
            case "error": terminated = true; callbacks.onError?.(new Error(data.message ?? "Unknown error")); return;
          }
        }
      }
    }
    if (!terminated) throw new Error("Connection closed unexpectedly");
  } finally {
    // Stop reading immediately after a terminal event. A subsequent network failure must not overwrite it.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Best-effort extraction of the `paragraphs` array from a partially-streamed
 * analysis JSON, so the UI can render sentences while the model is still writing.
 * `paragraphs` is the first key in the schema, which is what makes this possible.
 */
export function extractStreamingSentences(partial: string): string[] {
  const start = partial.indexOf('"paragraphs"');
  if (start === -1) return [];
  const out: string[] = [];
  // Every sentence object contributes a `"text": "..."` before its translation.
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(partial.slice(start))) !== null) {
    try {
      out.push(JSON.parse(`"${m[1]}"`));
    } catch {
      // partial escape at the stream edge — skip
    }
  }
  return out;
}

export function generateImportSentenceExplanation(language: string, sessionId: string, sentenceIndex: number, signal?: AbortSignal): Promise<{ sentenceIndex: number; readingAnalysis: ImportReadingAnalysis }> {
  return postJson(`/api/import/${encodeURIComponent(language)}/sessions/${encodeURIComponent(sessionId)}/sentences/${sentenceIndex}/explanation`, {}, signal);
}

export function analyzeNextImportPart(language: string, sessionId: string, chunkIndex: number, signal?: AbortSignal): Promise<ImportSession> {
  return postJson(`/api/import/${encodeURIComponent(language)}/sessions/${encodeURIComponent(sessionId)}/analyze-next`, { chunkIndex }, signal);
}

const jobSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
const jobPath = (language: string, id: string) => `/api/import/${encodeURIComponent(language)}/sessions/${encodeURIComponent(id)}/analysis-job`;
export function openImportAnalysisEvents(language: string, id: string): EventSource {
  return new EventSource(jobPath(language, id) + '/events', { withCredentials: true });
}
export function getImportAnalysisJob(language: string, id: string, signal?: AbortSignal): Promise<ImportAnalysisJobSummary> {
  return fetchJson(jobPath(language, id), jobSignal(signal));
}
export function startImportAnalysisJob(language: string, id: string, idempotencyKey: string, analysisRevision: number, signal?: AbortSignal): Promise<ImportAnalysisJobSummary> {
  return postJson(jobPath(language, id), { idempotencyKey, analysisRevision }, jobSignal(signal));
}
export function resumeImportAnalysisJob(language: string, id: string, idempotencyKey: string, signal?: AbortSignal): Promise<ImportAnalysisJobSummary> {
  return postJson(jobPath(language, id) + '/resume', { idempotencyKey }, jobSignal(signal));
}
export function pauseImportAnalysisJob(language: string, id: string, idempotencyKey: string): Promise<ImportAnalysisJobSummary> {
  return postJson(jobPath(language, id) + '/pause', { idempotencyKey }, jobSignal());
}

const revisionPath = (language: string, id: string) => `/api/import/${encodeURIComponent(language)}/sessions/${encodeURIComponent(id)}`;
export function listImportRevisions(language: string, id: string, signal?: AbortSignal): Promise<{ revisions: import("../types").ImportRevision[] }> {
  return fetchJson(`${revisionPath(language, id)}/revisions`, jobSignal(signal));
}
export function getImportRevision(language: string, id: string, revisionId: string, signal?: AbortSignal): Promise<import("../types").ImportRevision> {
  return fetchJson(`${revisionPath(language, id)}/revisions/${encodeURIComponent(revisionId)}`, jobSignal(signal));
}
export function createImportRevision(language: string, id: string, request: import("../types").ImportRevisionRequest): Promise<import("../types").ImportRevision> {
  return postJson(`${revisionPath(language, id)}/revisions`, request, jobSignal());
}
export function importRevisionAction(language: string, id: string, revisionId: string, action: "apply" | "reject" | "undo" | "restore", expectedRevision: number, changeIds: string[] = [], sentenceIndices: number[] = []): Promise<{ session: ImportSession; revision: import("../types").ImportRevision }> {
  return postJson(`${revisionPath(language, id)}/revisions/${encodeURIComponent(revisionId)}/${action}`, { expectedRevision, changeIds, sentenceIndices }, jobSignal());
}
export function convertImportGrammar(language: string, id: string, conversion: import("../types").ImportConversionInput, expectedRevision: number, idempotencyKey: string): Promise<{ session: ImportSession; revision: import("../types").ImportRevision }> {
  return postJson(`${revisionPath(language, id)}/candidate-conversions`, { conversion, expectedRevision, idempotencyKey }, jobSignal());
}
