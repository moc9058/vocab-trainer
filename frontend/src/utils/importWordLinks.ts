import type { ImportConstruction, ImportItem, ImportOccurrence, ImportSentence, ImportWordItem } from "../types";

// Mirrored in backend/src/import-word-links.ts; keep position-based conversion rules identical.
export function convertedWords(sentence: ImportSentence, items: ImportItem[]): ImportWordItem[] {
  return items.filter((item): item is ImportWordItem => item.kind === "word" && !!item.convertedFromGrammarId
    && items.some(source => source.id === item.convertedFromGrammarId && !!source.hiddenByRevision)
    && !item.hiddenByRevision && item.status !== "skipped" && item.sentenceIndex === sentence.index && !!item.range
    && sentence.text.slice(item.range.start, item.range.end) === item.surface);
}
const sameRange = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start === b.start && a.end === b.end;

/** A converted lexical word is a variable slot (x), never a fixed grammar token.
 * Match original positions, including repeated spellings, rather than replacing text globally. */
export function convertedConstruction(sentence: ImportSentence, items: ImportItem[], point: ImportConstruction, occurrences: ImportOccurrence[]): ImportConstruction {
  const words = convertedWords(sentence, items);
  if (!words.length) return point;
  const tokens = point.statement.split(/[+＋]/u).map(token => token.trim());
  const units = point.elements.length ? point.elements.flatMap((element, index) => {
    const linked = occurrences.filter(o => element.occurrenceIds.includes(o.id) && sentence.text.slice(o.range.start, o.range.end) === o.surface);
    return linked.length === element.occurrenceIds.length && linked.length
      ? [{ index, fixed: element.fixed, surface: linked.map(o => o.surface).join(""), linked }] : [];
  }) : point.ranges.flatMap(range => {
    const surface = sentence.text.slice(range.start, range.end);
    return surface ? [{ index: -1, fixed: true, surface, linked: [{ range, surface }] }] : [];
  });
  let cursor = 0, replaced = false;
  const changed = new Map<number, string>();
  for (const element of units) {
    const tokenIndex = element.fixed ? tokens.findIndex((token, index) => index >= cursor && token.replace(/\s/gu, "") === element.surface) : -1;
    if (tokenIndex >= 0) cursor = tokenIndex + 1;
    // Partial selection of a compound fixed element must not reclassify its other words.
    const selected = element.linked.map(o => words.find(w => sameRange(w.range!, o.range)));
    if (selected.some(word => !word)) continue;
    if (tokenIndex >= 0) { tokens[tokenIndex] = "x"; replaced = true; }
    if (element.index >= 0) changed.set(element.index, selected.map(word => word!.meaning ?? "").filter(Boolean).join(" / "));
  }
  if (!replaced && !changed.size) return point;
  return { ...point, statement: tokens.join(" + "), elements: point.elements.map((element, index) => changed.has(index)
    ? { ...element, fixed: false, role: "x", explanation: changed.get(index)! } : element) };
}

/** Persisted on explicit conversion; also used on read for articles converted by older versions. */
export function syncConvertedWordReading(sentence: ImportSentence, items: ImportItem[]): ImportSentence {
  const reading = sentence.readingAnalysis;
  if (!reading || reading.sourceText !== sentence.text) return sentence;
  const words = convertedWords(sentence, items);
  if (!words.length) return sentence;
  const occurrences = reading.occurrences.map(o => {
    const word = words.find(w => sameRange(w.range!, o.range));
    return word ? { ...o, lemma: word.term, contextualMeaning: word.meaning ?? o.contextualMeaning,
      transliteration: word.transliteration ?? o.transliteration, explanationLanguage: word.explanationLanguage ?? o.explanationLanguage } : o;
  });
  return { ...sentence, readingAnalysis: { ...reading, candidatesManaged: true, occurrences,
    constructions: reading.constructions.map(point => convertedConstruction(sentence, items, point, occurrences)) } };
}
