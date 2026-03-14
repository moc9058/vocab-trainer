import { fetchJson } from "./client";
import type { Word, PaginatedResult } from "../types";

interface WordFilters {
  search?: string;
  topic?: string;
  category?: string;
  level?: string;
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
  return fetchJson(`/api/vocab/${encodeURIComponent(language)}?${params}`);
}

export function getFilters(language: string): Promise<{ topics: string[]; categories: string[]; levels: string[] }> {
  return fetchJson(`/api/vocab/${encodeURIComponent(language)}/filters`);
}

export function getPinyinMap(language: string): Promise<Record<string, string>> {
  return fetchJson(`/api/vocab/${encodeURIComponent(language)}/pinyin-map`);
}
