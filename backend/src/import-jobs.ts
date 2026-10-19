import { createHash } from "node:crypto";
import type { ImportAnalysisJobSummary, ImportSession } from "./types.js";

export const JOB_LEASE_MS = 660_000;
export const MAX_JOB_ATTEMPTS = 3;
export const sourceHash = (text: string) => createHash("sha256").update(text).digest("hex");

export function importSentenceTexts(text: string, language: string): string[] {
  const locale = ({ chinese: "zh", english: "en", japanese: "ja", korean: "ko" } as Record<string, string>)[language] ?? "en";
  return [...new Intl.Segmenter(locale, { granularity: "sentence" }).segment(text)].map(s => s.segment.trim()).filter(Boolean);
}

/** Keep exact original spans, including paragraph whitespace and closing quotes. Never cut a sentence. */
export function planImportBatches(text: string, language: string, target = 600): string[] {
  const locale = ({ chinese: "zh", english: "en", japanese: "ja", korean: "ko" } as Record<string, string>)[language] ?? "en";
  const units = [...new Intl.Segmenter(locale, { granularity: "sentence" }).segment(text)].map(s => s.segment);
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current && current.length + unit.length > target) { chunks.push(current); current = ""; }
    current += unit;
  }
  if (current) chunks.push(current);
  if (chunks.join("") !== text) throw new Error("Source partition changed the original");
  return chunks;
}

export interface ImportJob extends ImportAnalysisJobSummary {
  kind?: "revision"; revisionId?: string; applyAttempts?: number;
  version: 2; sessionId: string; language: string; sourceHash: string;
  chunks: string[]; attempts: number; sequence: number; operationKey: string;
  snapshot: { model: string; system: string; schema: Record<string, unknown> };
  lease?: { token: string; until: number; attemptId: string };
  nextWakeAt: number; createdAt: string; cleanupAt: number;
}
export function jobSummary(job: ImportJob): ImportAnalysisJobSummary {
  const { id, generation, state, revision, nextBatch, totalBatches, completedSentences, pauseRequested, updatedAt, error } = job;
  return { id, generation, state, revision, nextBatch, totalBatches, completedSentences, pauseRequested, updatedAt,
    ...(job.progress ? { progress: job.progress } : {}), attempt: job.attempts,
    // Completed payloads are eventually cleaned; omit counts then rather than show zero.
    ...(job.chunks.length ? { completedCharacters: job.chunks.slice(0, nextBatch).join("").length, totalCharacters: job.chunks.join("").length } : {}),
    ...(state === "queued" && error && job.retryAt ? { retryAt: job.retryAt } : {}),
    ...(error ? { error } : {}) };
}
export const jobActive = (state: string | undefined) => state === "queued" || state === "running";
export function importJobError(err: unknown): { code: string; retryable: boolean } {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : "";
  if (/too large|storage|900.?000/i.test(message)) return { code: "IMPORT_STORAGE_LIMIT", retryable: false };
  if (/OUTPUT_LIMIT/i.test(message)) return { code: "IMPORT_OUTPUT_LIMIT", retryable: false };
  if (/SOURCE_MISMATCH|JSON|schema|reading analysis/i.test(message)) return { code: "IMPORT_INVALID_OUTPUT", retryable: false };
  if (status === 401 || status === 403 || status === 404 || /not configured|No import prompt/.test(message)) return { code: "IMPORT_CONFIG_ERROR", retryable: false };
  if (/time limit|timeout|timed out|disconnect/i.test(message)) return { code: "IMPORT_TIMEOUT", retryable: true };
  return { code: "IMPORT_ANALYSIS_FAILED", retryable: status === undefined || status === 429 || status >= 500 };
}

/** v1 display/checkpoint data is retained for the existing reader; the job controls execution. */
export function remainingJobChunks(session: ImportSession): { chunks: string[]; next: number } {
  const progress = session.analysisProgress;
  if (!progress) throw new Error("Article has no pending analysis");
  if (progress.chunks.join("") !== session.text) throw new Error("IMPORT_SOURCE_MISMATCH");
  return { chunks: progress.chunks, next: progress.nextChunk };
}
