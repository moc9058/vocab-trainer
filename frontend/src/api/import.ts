import { deleteRequest, fetchJson, postJson, putJson, CREDENTIALS, notifyIfUnauthorized } from "./client";
import type {
  ImportAnalysisResult,
  ImportQuizPool,
  ImportSession,
  ImportSessionSummary,
} from "../types";

// ----- Import sessions (paused, resumable article reviews) -----

type NewImportSession = Omit<ImportSession, "id" | "language" | "createdAt" | "updatedAt">;

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
  session: NewImportSession
): Promise<ImportSession> {
  return postJson(`/api/import/${encodeURIComponent(language)}/sessions`, session);
}

export function getImportSession(language: string, sessionId: string): Promise<ImportSession> {
  return fetchJson(
    `/api/import/${encodeURIComponent(language)}/sessions/${encodeURIComponent(sessionId)}`
  );
}

export function updateImportSession(
  language: string,
  sessionId: string,
  updates: Partial<NewImportSession>
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
  ) => void;
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
    body: JSON.stringify({ text }),
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ") && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6));
          switch (currentEvent) {
            case "analysis-start":
              callbacks.onStart?.();
              break;
            case "analysis-delta":
              callbacks.onDelta?.(data.text);
              break;
            case "analysis-result":
              callbacks.onResult?.(data.analysis, data.existing ?? {}, data.existingGrammar ?? {});
              break;
            case "done":
              terminated = true;
              callbacks.onDone?.();
              break;
            case "error":
              terminated = true;
              callbacks.onError?.(new Error(data.message ?? "Unknown error"));
              break;
          }
        } catch {
          // ignore malformed JSON
        }
        currentEvent = "";
      }
    }
  }

  if (!terminated) {
    callbacks.onError?.(new Error("Connection closed unexpectedly"));
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
