import type { ImportItem, ImportSentence, ImportWordItem } from '../types';
import { termOccurrences } from './importSession';

/** Prefer an explicit occurrence; legacy gap rows stored their exact offset in order. */
export function wordRepairRange(text: string, word: ImportWordItem) {
  if (word.range && Number.isInteger(word.range.start) && Number.isInteger(word.range.end)
    && text.slice(word.range.start, word.range.end) === (word.surface ?? word.term)
    && word.range.start >= 0 && word.range.end <= text.length && word.range.end > word.range.start) return word.range;
  const term = word.term.trim();
  if (!term) return undefined;
  if (Number.isInteger(word.order) && word.order >= 0 && text.slice(word.order, word.order + term.length) === term) {
    return { start: word.order, end: word.order + term.length };
  }
  const hits = termOccurrences(text, term);
  return hits.length === 1 ? { start: hits[0], end: hits[0] + term.length } : undefined;
}

export function importWordIssues(sentence: ImportSentence, items: ImportItem[]) {
  const words = items.filter((i): i is ImportWordItem => i.kind === 'word' && i.sentenceIndex === sentence.index
    && i.status !== 'skipped' && !i.hiddenByRevision && !i.suppressedByGrammar);
  return words.flatMap(word => {
    const range = wordRepairRange(sentence.text, word);
    const overlaps = !!range && words.some(other => {
      if (other.id === word.id) return false;
      const r = wordRepairRange(sentence.text, other);
      return r && range.start < r.end && r.start < range.end;
    });
    const invalid = word.range && (!Number.isInteger(word.range.start) || !Number.isInteger(word.range.end)
      || word.range.start < 0 || word.range.end > sentence.text.length || word.range.end <= word.range.start
      || sentence.text.slice(word.range.start, word.range.end) !== (word.surface ?? word.term));
    const position = !!invalid || !range || overlaps;
    const reading = word.transliteration?.trim();
    const missing = /\p{Script=Han}/u.test(word.surface ?? word.term)
      && (!reading || !/\p{Script=Latin}/u.test(reading) || /\p{Script=Han}/u.test(reading));
    return position || missing ? [{ word, position, range }] : [];
  });
}
