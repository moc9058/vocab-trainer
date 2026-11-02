import { isDeepStrictEqual } from "node:util";
import { normalizeWordRecord, normalizeWordSession } from "./word-format.js";

export const RETIRED_WORD_COLLECTIONS = ["words", "word_drafts", "quiz_sessions", "combined_quiz_sessions", "flagged_words"] as const;

/** An explicit collection allowlist prevents grammar/linguistic analysis changes. */
export function cleanRetiredWordData(collection: string, data: Record<string, unknown>): Record<string, unknown> | null {
  if (collection === "flagged_words") return null;
  if (collection === "words" || collection === "word_drafts") return normalizeWordRecord(data);
  if (collection === "quiz_sessions" || collection === "combined_quiz_sessions") return normalizeWordSession(data);
  return data;
}

export function retiredWordDataChanged(collection: string, data: Record<string, unknown>): boolean {
  return !isDeepStrictEqual(data, cleanRetiredWordData(collection, data));
}
