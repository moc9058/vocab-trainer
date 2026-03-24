import { fetchJson, postJson, deleteRequest } from "./client";
import type { Word } from "../types";

export function getFlaggedWords(language: string): Promise<{ words: Word[]; count: number }> {
  return fetchJson(`/api/flagged/${encodeURIComponent(language)}`);
}

export function getFlaggedWordCount(language: string): Promise<{ count: number }> {
  return fetchJson(`/api/flagged/${encodeURIComponent(language)}/count`);
}

export function flagWord(language: string, wordId: string): Promise<void> {
  return postJson(`/api/flagged/${encodeURIComponent(language)}/${encodeURIComponent(wordId)}`, {});
}

export function unflagWord(language: string, wordId: string): Promise<void> {
  return deleteRequest(`/api/flagged/${encodeURIComponent(language)}/${encodeURIComponent(wordId)}`);
}
