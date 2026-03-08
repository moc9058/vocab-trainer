import { fetchJson } from "./client";

export function getFilters(language: string): Promise<{ topics: string[]; categories: string[] }> {
  return fetchJson(`/api/vocab/${encodeURIComponent(language)}/filters`);
}
