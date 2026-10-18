import type { ImportConstruction, ImportItem, ImportOccurrence, ImportSentence, ImportSession, ImportWordItem } from "../types";
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
  const live = rows.filter(row => row.status !== "skipped" && !row.hiddenByRevision);
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
    if (original.length && !edited(row)) continue;
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
  // Compact imports can retain fixed elements only on grammar rows, without occurrence data.
  for (const item of items) {
    if (item.kind !== "grammar" || item.sentenceIndex !== sentence.index || item.status === "skipped" || item.hiddenByRevision || item.edited) continue;
    for (const element of item.fixedElements ?? []) add({
      id: `grammar-${item.id}-${element.range.start}`, range: element.range, surface: element.surface, lemma: element.surface,
      transliteration: element.transliteration, contextualMeaning: element.meaning, explanationLanguage: item.explanationLanguage ?? "ja",
      partOfSpeech: "", role: "", reasoning: "", contrast: "", senseKey: "", constructionIds: [item.constructionId ?? item.id],
    });
  }
  return result.sort((a, b) => a.range.start - b.range.start);
}

export function readingConstructions(sentence: ImportSentence, items: ImportItem[]): ImportConstruction[] {
  const rows = items.filter(item => item.kind === "grammar" && item.sentenceIndex === sentence.index).sort((a, b) => Number(!!a.hiddenByRevision) - Number(!!b.hiddenByRevision));
  const reading = validReading(sentence);
  const detailed = reading?.constructions.filter(point => {
    const row = rows.find(row => row.kind === "grammar" && patternKey(row.statement) === patternKey(point.statement)) ?? rows.find(row => row.kind === "grammar" && row.constructionId === point.id);
    return !row || !!row.hiddenByRevision && items.some(i => i.kind === "word" && i.convertedFromGrammarId === row.id) || (row.status !== "skipped" && !row.hiddenByRevision && row.kind === "grammar" && patternKey(row.statement) === patternKey(point.statement));
  }).map(point => {
    const row = rows.find(row => row.kind === "grammar" && patternKey(row.statement) === patternKey(point.statement)) ?? rows.find(row => row.kind === "grammar" && row.constructionId === point.id);
    return row?.kind === "grammar" && !reading?.candidatesManaged ? { ...point, meaning: row.description } : point;
  }) ?? [];
  return [...detailed, ...rows.flatMap(row => row.kind === "grammar" && row.status !== "skipped" && (!row.hiddenByRevision || items.some(i => i.kind === "word" && i.convertedFromGrammarId === row.id && !i.hiddenByRevision))
    && !reading?.constructions.some(point => point.id === row.constructionId || point.statement === row.statement) ? [{
    id: row.constructionId ?? row.id, statement: row.statement, meaning: row.description, roleInSentence: "",
    ranges: !row.edited && row.fixedElements?.length ? row.fixedElements.filter(element => sentence.text.slice(element.range.start, element.range.end) === element.surface).map(element => element.range) : row.excerpt ? termOccurrences(sentence.text, row.excerpt).map(start => ({ start, end: start + row.excerpt!.length })) : [], elements: [],
  }] : [])];
}

/** Only fixed grammar elements get a grammar marker; variable content slots remain words. */
export function fixedGrammarOccurrenceIds(sentence: ImportSentence, items: ImportItem[], occurrences: ImportOccurrence[]): Set<string> {
  const reading = validReading(sentence);
  const fixed = readingConstructions(sentence, items).flatMap(point => point.elements
    .filter(element => element.fixed)
    .flatMap(element => reading?.occurrences.filter(word => element.occurrenceIds.includes(word.id)) ?? []));
  // Compact imports retain fixed ranges on the editable grammar rows, without detailed constructions.
  const compact = items.flatMap(item => item.kind === "grammar" && item.sentenceIndex === sentence.index && item.status !== "skipped" && !item.hiddenByRevision && !item.edited
    && !reading?.constructions.some(point => point.id === item.constructionId || point.statement === item.statement)
    ? item.fixedElements ?? [] : []);
  const elements = [...fixed, ...compact];
  return new Set(occurrences.filter(word => !items.some(i => i.kind === "word" && i.convertedFromGrammarId && !i.hiddenByRevision && i.status !== "skipped" && i.sentenceIndex === sentence.index && i.range?.start === word.range.start && i.range.end === word.range.end) && elements.some(element =>
    element.range.start === word.range.start && element.range.end === word.range.end && element.surface === word.surface
    && sentence.text.slice(element.range.start, element.range.end) === element.surface)).map(word => word.id));
}

/** Resolve sentence-local links without guessing from spelling or broad legacy excerpts. */
export function occurrenceConstructions(word: ImportOccurrence, points: ImportConstruction[]): ImportConstruction[] {
  return points.filter(point => word.constructionIds.includes(point.id)
    || point.elements.some(element => element.occurrenceIds.includes(word.id))
    || point.ranges.some(range => range.start === word.range.start && range.end === word.range.end));
}

export interface ConstructionPart {
  key: string;
  label: string;
  fixed: boolean;
  slotIndex: number;
  role: string;
  explanation: string;
  words: ImportOccurrence[];
}

/** Use verified element links for slot boundaries; never infer A/B from surrounding text. */
export function constructionParts(sentence: ImportSentence, point: ImportConstruction, words: ImportOccurrence[], fixedIds: Set<string>): ConstructionPart[] {
  const original = validReading(sentence)?.occurrences ?? [];
  const elements = point.elements.flatMap((element, index) => {
    const sources = original.filter(word => element.occurrenceIds.includes(word.id));
    const linked = words.filter(word => sources.some(source => source.range.start === word.range.start && source.range.end === word.range.end && source.surface === word.surface));
    if (!linked.length || linked.length !== sources.length || sources.length !== element.occurrenceIds.length) return [];
    return [{ key: `${point.id}-${index}`, label: "", fixed: element.fixed, slotIndex: 0, role: element.role, explanation: element.explanation, words: linked }];
  }).sort((a, b) => a.words[0].range.start - b.words[0].range.start);
  const pattern = point.statement.split(/[+＋]/u).map(part => part.trim());
  const aligned = pattern.length === elements.length && elements.every((element, index) => element.fixed
    ? pattern[index].replace(/\s/gu, "") === element.words.map(word => word.surface).join("")
    : /^[a-z][a-z0-9]*$/iu.test(pattern[index]));
  let slotIndex = 0;
  for (const [index, element] of elements.entries()) {
    element.slotIndex = element.fixed ? -1 : slotIndex++;
    element.label = aligned ? pattern[index] : element.fixed ? element.words.map(word => word.surface).join("…") : element.role || String(element.slotIndex + 1);
  }
  if (elements.length || point.elements.length) return elements;
  // Compact sessions know fixed units only; content slots require a sentence explanation.
  return words.filter(word => fixedIds.has(word.id) && point.ranges.some(range => range.start === word.range.start && range.end === word.range.end))
    .map(word => ({ key: `${point.id}-${word.id}`, label: word.surface, fixed: true, slotIndex: -1, role: "", explanation: "", words: [word] }));
}

const patternKey = (value: string) => value.replace(/\s/gu, "");

/** Attach analysis to existing candidates without replacing edits, IDs or registration receipts. */
export function reconcileReadingSession(session: ImportSession): ImportSession {
  let items = [...session.items];
  for (const sentence of session.paragraphs.flatMap(p => p.sentences)) {
    const reading = validReading(sentence);
    if (!reading) {
      items = items.map(item => { if (item.kind !== "word" || item.sentenceIndex !== sentence.index || !item.suppressedByGrammar) return item;
        const { suppressedByGrammar: _old, ...rest } = item; return rest; });
      continue;
    }
    if (reading.candidatesManaged) continue;
    for (const point of reading.constructions) {
      const existing = items.find(item => item.kind === "grammar" && item.sentenceIndex === sentence.index
        && (item.constructionId === point.id || patternKey(item.statement) === patternKey(point.statement)));
      if (existing && (existing.edited || existing.status === "skipped")) continue;
      const fixedIds = new Set(point.elements.filter(element => element.fixed).flatMap(element => element.occurrenceIds));
      const fixedElements = reading.occurrences.filter(word => fixedIds.has(word.id)).map(word => ({ range: word.range, surface: word.surface, transliteration: word.transliteration, meaning: word.contextualMeaning }));
      if (existing) items = items.map(item => item.id === existing.id ? { ...item, constructionId: point.id, fixedElements } as ImportItem : item);
      else if (!reading.candidatesManaged) items.push({ id: `reading-grammar-${sentence.index}-${point.id}`, kind: "grammar", sentenceIndex: sentence.index, order: point.ranges[0]?.start ?? 0,
        origin: "llm", status: "pending", statement: point.statement, description: point.meaning, constructionId: point.id, fixedElements,
        explanationLanguage: reading.explanationLanguage });
    }
    const occurrences = readingOccurrences(sentence, items);
    const fixed = fixedGrammarOccurrenceIds(sentence, items, occurrences);
    items = items.map(item => {
      if (item.kind !== "word" || item.sentenceIndex !== sentence.index) return item;
      const match = occurrences.find(word => item.range ? item.range.start === word.range.start && item.range.end === word.range.end
        && (item.surface ?? item.term) === word.surface : item.occurrenceId === word.id);
      const suppressed = !item.edited && item.status !== "queued" && !!match && fixed.has(match.id);
      if (!!item.suppressedByGrammar === suppressed) return item;
      const { suppressedByGrammar: _old, ...rest } = item;
      return suppressed ? { ...rest, suppressedByGrammar: true } : rest;
    });
  }
  return JSON.stringify(items) === JSON.stringify(session.items) ? session : { ...session, items };
}

export function readingWordCandidate(sentence: ImportSentence, word: ImportOccurrence, items: ImportItem[]): ImportWordItem {
  const existing = items.find((item): item is ImportWordItem => item.kind === "word" && item.sentenceIndex === sentence.index && item.status !== "skipped" && !item.hiddenByRevision
    && (item.range ? item.range.start === word.range.start && item.range.end === word.range.end && (item.surface ?? item.term) === word.surface : item.term === word.lemma));
  return existing ?? { id: `reading-word-${sentence.index}-${word.id}`, kind: "word", sentenceIndex: sentence.index, order: word.range.start,
    origin: "llm", status: "pending", term: word.lemma, surface: word.surface, sourceTerm: word.lemma, range: word.range,
    occurrenceId: word.id, meaning: word.contextualMeaning, transliteration: word.transliteration, explanationLanguage: word.explanationLanguage };
}
