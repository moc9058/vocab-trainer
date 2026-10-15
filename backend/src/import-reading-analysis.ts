import type { ImportReadingAnalysis, ImportExtractedWord, ImportExtractedGrammar } from "./types.js";

export interface RawReadingWord {
  term: string;
  surface?: string;
  occurrence?: number;
  transliteration?: string;
  meaning?: string;
  partOfSpeech?: string;
  role?: string;
  reasoning?: string;
  contrast?: string;
  senseKey?: string;
}
export interface RawReadingGrammar {
  statement: string;
  description: string;
  excerpt?: string;
  roleInSentence?: string;
  elements?: { wordIndices: number[]; role: string; explanation: string; fixed: boolean }[];
}
export interface RawReadingSentence {
  text?: string;
  translation?: string;
  explanationLanguage?: string;
  overview?: string;
  ambiguityNotes?: string[];
  words?: RawReadingWord[];
  grammar?: RawReadingGrammar[];
}

/** Resolve verbatim surface + occurrence ordinal, never guess an ambiguous first hit. */
export function normalizeReadingSentence(
  raw: RawReadingSentence,
  sentenceIndex: number,
  occurrences: (text: string, term: string) => number[],
  normalizeStatement: (statement: string) => string,
): { reading: ImportReadingAnalysis; words: ImportExtractedWord[]; grammar: ImportExtractedGrammar[] } {
  const text = raw.text ?? "";
  const language = ["ja", "en", "ko", "zh"].includes(raw.explanationLanguage ?? "") ? raw.explanationLanguage! : "ja";
  const reading: ImportReadingAnalysis = {
    version: 1, sourceText: text, explanationLanguage: language,
    overview: raw.overview ?? "", ambiguityNotes: raw.ambiguityNotes ?? [], occurrences: [], constructions: [],
  };
  const words: ImportExtractedWord[] = [];
  const byRawIndex = new Map<number, string>();
  const used = new Set<string>();
  (raw.words ?? []).forEach((word, i) => {
    const surface = word.surface?.trim();
    if (!surface || !/\p{L}/u.test(surface) || !word.term?.trim() || !Number.isInteger(word.occurrence) || word.occurrence! < 0) return;
    const start = occurrences(text, surface).filter(at => text.slice(at, at + surface.length) === surface)[word.occurrence!];
    if (start === undefined) return;
    const key = `${start}:${start + surface.length}`;
    if (used.has(key)) return;
    used.add(key);
    const id = `s${sentenceIndex}-o${i}`;
    byRawIndex.set(i, id);
    const range = { start, end: start + surface.length };
    reading.occurrences.push({
      id, range, surface, lemma: word.term.trim(), transliteration: word.transliteration ?? "",
      contextualMeaning: word.meaning ?? "", explanationLanguage: language,
      partOfSpeech: word.partOfSpeech ?? "", role: word.role ?? "", reasoning: word.reasoning ?? "",
      contrast: word.contrast ?? "", senseKey: word.senseKey ?? "", constructionIds: [],
    });
    words.push({ term: word.term.trim(), transliteration: word.transliteration, meaning: word.meaning,
      sentenceIndex, occurrenceId: id, surface, sourceTerm: word.term.trim(), range, explanationLanguage: language });
  });
  const grammar: ImportExtractedGrammar[] = [];
  const statements = new Set<string>();
  (raw.grammar ?? []).forEach((point, i) => {
    if (!point.statement?.trim()) return;
    const statement = normalizeStatement(point.statement.trim());
    if (statements.has(statement)) return;
    statements.add(statement);
    const id = `s${sentenceIndex}-c${i}`;
    const elements = (point.elements ?? []).flatMap(element => {
      const ids = element.wordIndices.map(index => byRawIndex.get(index)).filter((value): value is string => !!value);
      // A partially invalid element must not suppress any candidate.
      if (!ids.length || ids.length !== element.wordIndices.length) return [];
      return [{ occurrenceIds: ids, role: element.role, explanation: element.explanation, fixed: element.fixed }];
    });
    const linked = reading.occurrences.filter(word => elements.some(element => element.occurrenceIds.includes(word.id)));
    for (const word of linked) word.constructionIds.push(id);
    reading.constructions.push({ id, statement, ranges: linked.map(word => word.range),
      meaning: point.description, roleInSentence: point.roleInSentence ?? "", elements });
    const fixedIds = new Set(elements.filter(element => element.fixed && element.explanation.trim()).flatMap(element => element.occurrenceIds));
    const fixedElements = linked.filter(word => fixedIds.has(word.id) && word.contextualMeaning.trim() && word.transliteration?.trim())
      .map(word => ({ range: word.range, surface: word.surface, transliteration: word.transliteration, meaning: word.contextualMeaning }));
    grammar.push({ statement, description: point.description, sentenceIndex, constructionId: id,
      explanationLanguage: language, fixedElements,
      ...(point.excerpt && text.includes(point.excerpt) ? { excerpt: point.excerpt } : {}) });
  });
  return { reading, words, grammar };
}

/** Every sentence must be copied verbatim in source order; only inter-sentence whitespace may be omitted. */
export function sourceMatchesSentences(source: string, sentences: string[]): boolean {
  let cursor = 0;
  for (const sentence of sentences) {
    if (!sentence) return false;
    const start = source.indexOf(sentence, cursor);
    if (start < 0 || source.slice(cursor, start).trim()) return false;
    cursor = start + sentence.length;
  }
  return sentences.length > 0 && !source.slice(cursor).trim();
}
