import type { SearchIndexEntry, SearchIn } from "../types";

/**
 * Pure matcher for the search preview. Case-insensitive, NFC-normalized
 * `includes` — correct for CJK (no tokenization to get wrong) and acceptable
 * for Latin. Prefix matches on the label rank first, then label matches,
 * then transliteration/meaning-only matches.
 */
export interface SearchMatch {
  entry: SearchIndexEntry;
  /** [start, end) span of the match inside `entry.label`, when the label matched. */
  labelSpan?: [number, number];
  /** First meanings[] string that matched, for the row's snippet. */
  matchedMeaning?: string;
}

function norm(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

export function matchSearchIndex(
  entries: SearchIndexEntry[],
  query: string,
  searchIn: SearchIn
): SearchMatch[] {
  const q = norm(query.trim());
  if (!q) return [];

  const prefix: SearchMatch[] = [];
  const label: SearchMatch[] = [];
  const other: SearchMatch[] = [];

  for (const entry of entries) {
    const byTerm = searchIn !== "meaning";
    const byMeaning = searchIn !== "term";

    if (byTerm) {
      const idx = norm(entry.label).indexOf(q);
      if (idx >= 0) {
        const m: SearchMatch = { entry, labelSpan: [idx, idx + q.length] };
        (idx === 0 ? prefix : label).push(m);
        continue;
      }
      if (entry.transliteration && norm(entry.transliteration).includes(q)) {
        other.push({ entry });
        continue;
      }
    }
    if (byMeaning) {
      const hit = entry.meanings.find((t) => norm(t).includes(q));
      if (hit) other.push({ entry, matchedMeaning: hit });
    }
  }

  return [...prefix, ...label, ...other];
}
