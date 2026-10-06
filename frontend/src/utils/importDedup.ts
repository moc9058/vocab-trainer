/** Deterministic sentence-local extraction cleanup. Mirrored across the two packages. */
export interface ExtractedSpan {
  sentenceIndex: number;
  term: string;
  transliteration?: string;
  meaning?: string;
}

export function deduplicateWords<T extends ExtractedSpan>(
  rows: T[],
  textOf: (index: number) => string,
  occurrences: (text: string, term: string) => number[],
  merge: (a: T, b: T) => T = (a, b) => ({ ...a,
    transliteration: a.transliteration || b.transliteration,
    meaning: a.meaning || b.meaning }),
  compatible: (a: T, b: T) => boolean = () => true,
  canDrop: (row: T) => boolean = () => true,
): T[] {
  const kept: T[] = [];
  const agrees = (a?: string, b?: string) => !a?.trim() || !b?.trim() || a.trim() === b.trim();
  for (const row of rows) {
    const index = kept.findIndex(a => a.sentenceIndex === row.sentenceIndex &&
      a.term.trim() === row.term.trim() && agrees(a.transliteration, row.transliteration) &&
      agrees(a.meaning, row.meaning) && compatible(a, row));
    if (index < 0) kept.push(row);
    else kept[index] = merge(kept[index], row);
  }
  return kept.filter(row => {
    if (!canDrop(row)) return true;
    const term = row.term.trim();
    const text = textOf(row.sentenceIndex);
    const hits = occurrences(text, term);
    if (!hits.length) return true; // inflected or otherwise uncertain: preserve
    const longer = kept.filter(other => other.sentenceIndex === row.sentenceIndex &&
      other.term.trim().length > term.length);
    return !hits.every(at => longer.some(other => {
      const long = other.term.trim();
      return occurrences(text, long).some(start => start <= at && start + long.length >= at + term.length);
    }));
  });
}
