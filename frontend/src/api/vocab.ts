import { fetchJson, postJson, putJson, deleteRequest } from "./client";
import type { Word, Meaning, PaginatedResult } from "../types";

interface WordFilters {
  search?: string;
  topic?: string;
  category?: string;
  level?: string;
  flaggedOnly?: boolean;
}

export async function getWords(
  language: string,
  filters?: WordFilters,
  page = 1,
  limit = 50
): Promise<PaginatedResult<Word>> {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  if (filters?.search) params.set("search", filters.search);
  if (filters?.topic) params.set("topic", filters.topic);
  if (filters?.category) params.set("category", filters.category);
  if (filters?.level) params.set("level", filters.level);
  if (filters?.flaggedOnly) params.set("flaggedOnly", "true");
  return fetchJson(`/api/vocab/${encodeURIComponent(language)}?${params}`);
}

export function getFilters(language: string): Promise<{ topics: string[]; categories: string[]; levels: string[] }> {
  return fetchJson(`/api/vocab/${encodeURIComponent(language)}/filters`);
}

export function updateWord(language: string, wordId: string, updates: Partial<Word>): Promise<Word> {
  return putJson(`/api/vocab/${encodeURIComponent(language)}/${encodeURIComponent(wordId)}`, updates);
}

export function deleteWord(language: string, wordId: string): Promise<void> {
  return deleteRequest(`/api/vocab/${encodeURIComponent(language)}/${encodeURIComponent(wordId)}`);
}

export function unlinkSegmentFromExample(
  language: string,
  wordId: string,
  sentence: string,
): Promise<{ action: "deleted" | "preserved" | "noop"; word?: Word }> {
  return postJson(
    `/api/vocab/${encodeURIComponent(language)}/${encodeURIComponent(wordId)}/unlink-segment`,
    { sentence },
  );
}

export function checkTerms(language: string, terms: string[]): Promise<{ existing: Record<string, string> }> {
  return postJson(`/api/vocab/${encodeURIComponent(language)}/check-terms`, { terms });
}

export async function lookupWord(
  language: string,
  term: string,
): Promise<{ term: string; id: string; level: string; transliteration: string } | null> {
  const res = await fetch(
    `/api/vocab/${encodeURIComponent(language)}/lookup?term=${encodeURIComponent(term)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function smartAddWord(
  language: string,
  data: {
    term: string;
    transliteration?: string;
    definitions?: Meaning[];
    topics?: string[];
    examples?: { sentence: string; translation: string; userSplits?: string[]; segments?: { text: string; transliteration?: string; id?: string }[] }[];
    level?: string;
    flag?: boolean;
  }
): Promise<Word & { generatedWords?: Word[] }> {
  return postJson(`/api/vocab/${encodeURIComponent(language)}/smart-add`, data);
}

export function syncSegmentLinks(language: string, exampleIds: string[]): Promise<void> {
  return postJson(`/api/vocab/${encodeURIComponent(language)}/sync-segment-links`, { exampleIds });
}
