import { normalizeMeaningUnits } from './import-meaning-units.js';
import type { ImportAnalysisResult, ImportReadingAnalysis, ImportExtractedWord, ImportExtractedGrammar } from "./types.js";

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
  comprehension?: Omit<NonNullable<ImportReadingAnalysis["comprehension"]>, "meaningUnits"> & { meaningUnits?: unknown };
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
  if (raw.comprehension) {
    const c = raw.comprehension;
    if (typeof c.meaning !== "string" || !c.meaning.trim() || typeof c.skeleton !== "string" || typeof c.connection !== "string" || !Array.isArray(c.nuances)
      || c.nuances.some(n => typeof n.text !== "string" || typeof n.evidence !== "string" || !n.evidence.trim() || !text.includes(n.evidence) || !["explicit", "inferred", "uncertain"].includes(n.certainty))) throw new Error("Invalid reading analysis comprehension evidence");
    const { meaningUnits, ...rest } = c;
    reading.comprehension = { ...rest, ...(meaningUnits !== undefined ? { meaningUnits: normalizeMeaningUnits(text, meaningUnits) } : {}) };
  }
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
    const fixedIds = new Set(elements.filter(element => element.fixed).flatMap(element => element.occurrenceIds));
    const fixedElements = linked.filter(word => fixedIds.has(word.id))
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

/** Preserve sentence-local links when a compact batch is appended to an existing article. */
export function rebaseReadingAnalysis(reading: ImportReadingAnalysis, offset: number): ImportReadingAnalysis {
  const reindex = (id: string) => id.replace(/^s(\d+)-/, (_match, index) => `s${Number(index) + offset}-`);
  return { ...reading, occurrences: reading.occurrences.map(word => ({ ...word, id: reindex(word.id), constructionIds: word.constructionIds.map(reindex) })),
    constructions: reading.constructions.map(point => ({ ...point, id: reindex(point.id), elements: point.elements.map(element => ({ ...element, occurrenceIds: element.occurrenceIds.map(reindex) })) })) };
}

/** A successful Chinese analysis must never silently lose readings on linked grammar words/slots. */
export function assertGrammarPinyin(analysis: ImportAnalysisResult, language: string): void {
  if (language !== "chinese") return;
  const hasReading = (surface: string, reading?: string) => !/\p{Script=Han}/u.test(surface)
    || (!!reading?.trim() && /\p{Script=Latin}/u.test(reading) && !/\p{Script=Han}/u.test(reading));
  for (const sentence of analysis.paragraphs.flatMap(p => p.sentences)) {
    const reading = sentence.readingAnalysis;
    if (!reading) continue;
    const linked = new Set(reading.constructions.flatMap(point => point.elements.flatMap(element => element.occurrenceIds)));
    if (reading.occurrences.some(word => linked.has(word.id) && !hasReading(word.surface, word.transliteration))) {
      throw new Error("IMPORT_GRAMMAR_PINYIN_MISSING: Regenerate the sentence analysis with pinyin for every Chinese grammar element and slot.");
    }
  }
  if (analysis.grammar.some(point => point.fixedElements?.some(element => !hasReading(element.surface, element.transliteration)))) {
    throw new Error("IMPORT_GRAMMAR_PINYIN_MISSING: Fixed Chinese grammar elements require pinyin.");
  }
}
