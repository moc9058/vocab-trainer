import type { ImportConstruction, ImportItem, ImportOccurrence, ImportSentence, ImportWordItem } from "../types";
import { termOccurrences } from "./importSession";

export function validReading(sentence: ImportSentence) {
  return sentence.readingAnalysis?.version === 1 && sentence.readingAnalysis.sourceText === sentence.text
    ? sentence.readingAnalysis : undefined;
}

function rangeValid(text: string, word: ImportOccurrence) {
  const { start, end } = word.range;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length && text.slice(start, end) === word.surface;
}

/** Derive a non-overlapping rendering from current edit rows and verified original occurrences. */
export function readingOccurrences(sentence: ImportSentence, items: ImportItem[]): ImportOccurrence[] {
  const rows = items.filter((item): item is ImportWordItem => item.kind === "word" && item.sentenceIndex === sentence.index);
  const live = rows.filter(row => row.status !== "skipped");
  const original = validReading(sentence)?.occurrences.filter(word => rangeValid(sentence.text, word)) ?? [];
  const result: ImportOccurrence[] = [];
  const claimed = new Set<number>();
  function add(word: ImportOccurrence) {
    if (!rangeValid(sentence.text, word)) return;
    for (let i = word.range.start; i < word.range.end; i++) if (claimed.has(i)) return;
    for (let i = word.range.start; i < word.range.end; i++) claimed.add(i);
    result.push(word);
  }
  // User edits and derived rows take precedence over now-stale analysis links.
  const edited = (row: ImportWordItem) => row.edited || row.origin !== "llm";
  for (const row of [...live].sort((a, b) => Number(!!edited(b)) - Number(!!edited(a)) || b.term.length - a.term.length)) {
    const source = original.find(word => word.lemma === row.term.trim() && word.range.start === row.range?.start && word.range.end === row.range?.end && word.surface === row.surface);
    if (source) {
      add({ ...source, contextualMeaning: row.meaning ?? source.contextualMeaning, transliteration: row.transliteration ?? source.transliteration });
      continue;
    }
    // A later sentence-only explanation is independent of old untouched review rows.
    if (original.length && !edited(row) && !row.occurrenceId) continue;
    const term = row.term.trim();
    const starts = row.range && row.sourceTerm === term && row.surface && sentence.text.slice(row.range.start, row.range.end) === row.surface
      ? [row.range.start] : termOccurrences(sentence.text, term);
    for (const start of starts) {
      const verified = original.find(word => word.range.start === start && word.surface === term && word.lemma === term);
      add({ ...(verified ?? {}), id: `row-${row.id}-${start}`, range: { start, end: row.range && starts.length === 1 && start === row.range.start && row.sourceTerm === term ? row.range.end : start + term.length }, surface: row.sourceTerm === term && row.surface ? row.surface : term, lemma: term,
        contextualMeaning: row.meaning ?? "", transliteration: row.transliteration,
        explanationLanguage: row.explanationLanguage ?? "ja", partOfSpeech: verified?.partOfSpeech ?? "",
        role: verified?.role ?? "", reasoning: verified?.reasoning ?? "", contrast: verified?.contrast ?? "",
        senseKey: verified?.senseKey ?? "", constructionIds: verified?.constructionIds ?? [] });
    }
  }
  for (const word of original) {
    const row = rows.find(row => row.sourceTerm === word.lemma && row.range?.start === word.range.start && row.range.end === word.range.end);
    if (row && (row.status === "skipped" || row.term.trim() !== word.lemma)) continue;
    add(word);
  }
  return result.sort((a, b) => a.range.start - b.range.start);
}

export function readingConstructions(sentence: ImportSentence, items: ImportItem[]): ImportConstruction[] {
  const rows = items.filter(item => item.kind === "grammar" && item.sentenceIndex === sentence.index);
  const reading = validReading(sentence);
  if (reading) return reading.constructions.filter(point => {
    const row = rows.find(row => row.kind === "grammar" && row.statement === point.statement) ?? rows.find(row => row.kind === "grammar" && row.constructionId === point.id);
    return !row || (row.status !== "skipped" && row.kind === "grammar" && row.statement === point.statement);
  }).map(point => {
    const row = rows.find(row => row.kind === "grammar" && row.statement === point.statement) ?? rows.find(row => row.kind === "grammar" && row.constructionId === point.id);
    return row?.kind === "grammar" ? { ...point, meaning: row.description } : point;
  });
  return rows.flatMap(row => row.kind === "grammar" && row.status !== "skipped" ? [{
    id: row.id, statement: row.statement, meaning: row.description, roleInSentence: "",
    ranges: row.excerpt ? termOccurrences(sentence.text, row.excerpt).map(start => ({ start, end: start + row.excerpt!.length })) : [], elements: [],
  }] : []);
}
