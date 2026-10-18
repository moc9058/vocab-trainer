import { expect, it } from "vitest";
import fixture from "./__fixtures__/import-context.json";
import type { ImportAnalysisResult, ImportItem } from "../types";
import { buildImportItems, materializeGaps, sentenceCoverage, sentenceItems, splitWordItem, mergeWordItems, undoDerivation } from "./importSession";
import { constructionParts, fixedGrammarOccurrenceIds, occurrenceConstructions, readingOccurrences, readingConstructions, reconcileReadingSession, validReading } from "./importReadingAnalysis";

const analysis = fixture as ImportAnalysisResult;
const sentence = analysis.paragraphs[0].sentences[0];
const fresh = () => buildImportItems(analysis, {}, {}, "chinese");

it("suppresses only fixed occurrences while retaining content slots and no resurrected gap rows", () => {
  const items = fresh();
  const { words, grammar } = sentenceItems(items, 0);
  expect(words.map(word => word.term)).toEqual(["该", "公司", "采取", "行动"]);
  expect(words[0].meaning).toBe("その");
  expect(sentenceCoverage(sentence.text, words, "chinese", grammar).complete).toBe(true);
  expect(materializeGaps(items, 0, sentence.text, "chinese")).toEqual(items);
  const occurrences = readingOccurrences(sentence, items);
  expect(occurrences.filter(word => word.surface === "该").map(word => word.contextualMeaning)).toEqual(["その", "そろそろ〜すべき"]);
  expect(occurrences.find(word => word.surface === "了")?.transliteration).toBe("le");
});

it("removing a grammar candidate stops its elements from claiming coverage", () => {
  const items = fresh().map(item => item.kind === "grammar" ? { ...item, status: "skipped" as const } : item);
  const { words, grammar } = sentenceItems(items, 0);
  expect(sentenceCoverage(sentence.text, words, "chinese", grammar).missing).toBe(2);
  expect(readingConstructions(sentence, items)).toHaveLength(0);
});

it("live edits override their linked occurrence but never other same-spelling occurrences", () => {
  const items = fresh().map(item => item.kind === "word" && item.term === "该" ? { ...item, meaning: "当該の", transliteration: "gāi", edited: true } : item);
  expect(readingOccurrences(sentence, items).filter(word => word.surface === "该").map(word => word.contextualMeaning)).toEqual(["当該の", "そろそろ〜すべき"]);
});

it("split and undo do not reattach the old whole-word explanation to new parts", () => {
  const items = fresh();
  const source = items.find(item => item.kind === "word" && item.term === "行动")!;
  const split = splitWordItem(items, source.id, ["行", "动"]);
  const rendered = readingOccurrences(sentence, split);
  expect(rendered.some(word => word.surface === "行动")).toBe(false);
  expect(rendered.find(word => word.surface === "行")?.contextualMeaning).toBe("");
  const derived = split.find(item => item.sourceIds?.includes(source.id))!;
  expect(readingOccurrences(sentence, undoDerivation(split, derived.id)).some(word => word.surface === "行动")).toBe(true);
});

it("stale analysis and invalid ranges are never rendered", () => {
  expect(validReading({ ...sentence, text: "changed" })).toBeUndefined();
  const invalid = structuredClone(sentence);
  invalid.readingAnalysis!.occurrences[0].range.start = 100;
  expect(readingOccurrences(invalid, []).some(word => word.surface === "该" && word.contextualMeaning === "その")).toBe(false);
});

it("old sessions retain clickable saved words and grammar", () => {
  const items: ImportItem[] = [
    { id: "old", kind: "word", sentenceIndex: 0, order: 0, status: "pending", origin: "llm", term: "你好", transliteration: "nǐ hǎo", meaning: "こんにちは" },
    { id: "grammar", kind: "grammar", sentenceIndex: 0, order: 0, status: "pending", origin: "llm", statement: "你好", description: "挨拶" },
  ];
  expect(readingOccurrences({ index: 0, text: "你好。" }, items)[0].contextualMeaning).toBe("こんにちは");
  expect(readingConstructions({ index: 0, text: "你好。" }, items)[0].meaning).toBe("挨拶");
});

it("very dense compact articles exceed the explicit storage guard without losing same-spelling readings", () => {
  const long: ImportAnalysisResult = { paragraphs: [], words: [], grammar: [] };
  let text = "";
  for (let index = 0; ; index++) {
    const original = analysis.paragraphs[index % 2].sentences[0];
    if ((text + original.text).length > 8000) break;
    text += original.text;
    long.paragraphs.push({ sentences: [{ index, text: original.text, translation: original.translation }] });
    long.words.push(...analysis.words.filter(word => word.sentenceIndex === index % 2).map(word => ({ ...word, sentenceIndex: index, occurrenceId: `s${index}-${word.range?.start}` })));
  }
  const items = buildImportItems(long, {}, {}, "chinese");
  const savedBytes = new TextEncoder().encode(JSON.stringify({ text, paragraphs: long.paragraphs, items })).length;
  expect(text.length).toBeGreaterThan(7900);
  expect(savedBytes).toBeGreaterThan(900_000); // Base candidate rows alone can exceed the document budget: the API must ask for smaller sections.
  const second = long.paragraphs[1].sentences[0];
  expect(readingOccurrences(second, items).filter(word => word.surface === "还").map(word => word.transliteration)).toEqual(["hái", "huán"]);
});

it("noncontiguous grammar coverage never swallows the intervening lexical slots", () => {
  const point: ImportAnalysisResult = { paragraphs: [{ sentences: [{ index: 0, text: "越学越懂。" }] }],
    words: ["越", "学", "越", "懂"].map((term, start) => ({ term, sentenceIndex: 0, occurrenceId: `o${start}`, range: { start, end: start + 1 }, surface: term, sourceTerm: term, transliteration: "test", meaning: term })),
    grammar: [{ sentenceIndex: 0, statement: "越+v+越+v", description: "程度の連動", constructionId: "c0", fixedElements: [0, 2].map(start => ({ range: { start, end: start + 1 }, surface: "越", transliteration: "yuè", meaning: "程度の連動" })) }] };
  const items = buildImportItems(point, {}, {}, "chinese");
  expect(sentenceItems(items, 0).words.map(word => word.term)).toEqual(["学", "懂"]);
  expect(items.some(item => item.origin === "gap")).toBe(false);
});

it("regenerated occurrence IDs may change while range-linked inflected words keep their new explanation", () => {
  const sentence = { index: 3, text: "食べました。", readingAnalysis: { version: 1 as const, sourceText: "食べました。", explanationLanguage: "ja", overview: "動詞", ambiguityNotes: [], constructions: [],
    occurrences: [{ id: "regenerated", range: { start: 0, end: 5 }, surface: "食べました", lemma: "食べる", contextualMeaning: "食事する", transliteration: "tabemashita", explanationLanguage: "ja", partOfSpeech: "verb", role: "過去の述語", reasoning: "ました", contrast: "", senseKey: "eat", constructionIds: [] }] } };
  const row: ImportItem = { id: "word", kind: "word", sentenceIndex: 3, order: 0, status: "pending", origin: "llm", term: "食べる", sourceTerm: "食べる", surface: "食べました", range: { start: 0, end: 5 }, occurrenceId: "old-id" };
  expect(readingOccurrences(sentence, [row])[0].role).toBe("過去の述語");
});

it("reader markers distinguish fixed grammar from same-spelling words and variable slots", () => {
  const items = fresh();
  const occurrences = readingOccurrences(sentence, items);
  const fixed = fixedGrammarOccurrenceIds(sentence, items, occurrences);
  expect(occurrences.filter(word => fixed.has(word.id)).map(word => word.range.start)).toEqual([3, 8]);
  const removed = items.map(item => item.kind === "grammar" ? { ...item, status: "skipped" as const } : item);
  expect(fixedGrammarOccurrenceIds(sentence, removed, occurrences).size).toBe(0);
  const compact = structuredClone(sentence);
  compact.readingAnalysis!.constructions = [];
  expect([...fixedGrammarOccurrenceIds(compact, items, occurrences)]).toEqual([...fixed]);
  const edited = items.map(item => item.kind === "grammar" ? { ...item, edited: true, statement: "edited" } : item);
  expect(fixedGrammarOccurrenceIds(sentence, edited, occurrences).size).toBe(0);
});

it("links compact fixed elements by occurrence while leaving repeated spelling and variable slots separate", () => {
  const compact = { ...sentence, readingAnalysis: undefined };
  const items = fresh();
  const words = readingOccurrences(compact, items);
  const points = readingConstructions(compact, items);
  expect(points).toHaveLength(1);
  expect(words.filter(word => occurrenceConstructions(word, points).length).map(word => word.range.start)).toEqual([3, 8]);
  expect(points[0].ranges).toEqual([{ start: 3, end: 4 }, { start: 8, end: 9 }]);
  const removed = items.map(item => item.kind === "grammar" ? { ...item, status: "skipped" as const } : item);
  expect(readingOccurrences(compact, removed).some(word => word.range.start === 8)).toBe(false);
});

it("separates A and B from fixed grammar using validated elements rather than the full excerpt", () => {
  const current = structuredClone(sentence);
  current.text = "甲公司与乙学校合作。";
  const surfaces = ["甲", "公司", "与", "乙", "学校", "合作"];
  let cursor = 0;
  const words = surfaces.map((surface, index) => {
    const start = cursor; cursor += surface.length;
    return { ...current.readingAnalysis!.occurrences[0], id: `o${index}`, range: { start, end: cursor }, surface, constructionIds: [] };
  });
  current.readingAnalysis!.sourceText = current.text;
  current.readingAnalysis!.occurrences = words;
  const point = { id: "c", statement: "A + 与 + B", ranges: words.slice(0, 5).map(word => word.range), meaning: "", roleInSentence: "",
    elements: [{ occurrenceIds: ["o0", "o1"], fixed: false, role: "A", explanation: "" }, { occurrenceIds: ["o2"], fixed: true, role: "接続", explanation: "" }, { occurrenceIds: ["o3", "o4"], fixed: false, role: "B", explanation: "" }] };
  const parts = constructionParts(current, point, words, new Set(["o2"]));
  expect(parts.map(part => [part.label, part.fixed, part.words.map(word => word.surface).join("")])).toEqual([
    ["A", false, "甲公司"], ["与", true, "与"], ["B", false, "乙学校"],
  ]);
  // A split/edited occurrence cannot inherit an old element boundary.
  expect(constructionParts(current, point, words.filter(word => word.id !== "o1"), new Set()).map(part => part.label)).not.toContain("A");
  expect(constructionParts({ ...current, text: "changed" }, point, words, new Set())).toEqual([]);
  expect(constructionParts(current, { ...point, elements: [], ranges: [words[2].range] }, words, new Set(["o2"])).map(part => part.fixed)).toEqual([true]);
});

it("sentence analysis suppresses only fixed occurrences while preserving edited rows and registration receipts", () => {
  const words = sentence.readingAnalysis!.occurrences;
  const items: ImportItem[] = [...fresh(), { id: "fixed-old", kind: "word", sentenceIndex: 0, order: 3, status: "registered", origin: "llm", term: "该", surface: "该", sourceTerm: "该", range: words[2].range, occurrenceId: words[2].id,
    existingWordId: "library-word", registrations: { A: { status: "registered" } } }];
  const session: any = { id: "test", paragraphs: [{ sentences: [sentence] }], items };
  const next = reconcileReadingSession(session);
  expect(next.items.find(item => item.id === "fixed-old")).toMatchObject({ suppressedByGrammar: true, status: "registered", existingWordId: "library-word", registrations: { A: { status: "registered" } } });
  expect(sentenceItems(next.items, 0).words.map(word => word.term)).toEqual(["该", "公司", "采取", "行动"]);
  const removed = reconcileReadingSession({ ...next, items: next.items.map(item => item.kind === "grammar" ? { ...item, status: "skipped" as const } : item) });
  expect(removed.items.find(item => item.id === "fixed-old")?.kind === "word" && (removed.items.find(item => item.id === "fixed-old") as any).suppressedByGrammar).toBeUndefined();
  expect(reconcileReadingSession(next)).toBe(next);
});

it("split and merge change only the edited occurrence when a sentence repeats the same word", () => {
  const repeated = { index: 0, text: "行动好行动好。" };
  const items: ImportItem[] = [0, 3].flatMap((start, index) => [
    { id: `action${index}`, kind: "word" as const, sentenceIndex: 0, order: start, status: "pending" as const, origin: "llm" as const, term: "行动", sourceTerm: "行动", surface: "行动", range: { start, end: start + 2 } },
    { id: `good${index}`, kind: "word" as const, sentenceIndex: 0, order: start + 2, status: "pending" as const, origin: "llm" as const, term: "好", sourceTerm: "好", surface: "好", range: { start: start + 2, end: start + 3 } },
  ]);
  const split = splitWordItem(items, "action1", ["行", "动"]);
  expect(readingOccurrences(repeated, split).map(word => [word.surface, word.range.start])).toEqual([["行动", 0], ["好", 2], ["行", 3], ["动", 4], ["好", 5]]);
  const merged = mergeWordItems(items, ["action1", "good1"], repeated.text);
  expect(readingOccurrences(repeated, merged).map(word => [word.surface, word.range.start])).toEqual([["行动", 0], ["好", 2], ["行动好", 3]]);
});

it('conversion keeps construction explanations, prevents fixed-word suppression and never restores the hidden candidate', () => {
  const items = fresh();
  const source = items.find(i => i.kind === 'grammar')!;
  const fixed = sentence.readingAnalysis!.occurrences.find(o => sentence.readingAnalysis!.constructions.some(c => c.elements.some(e => e.fixed && e.occurrenceIds.includes(o.id))))!;
  const session = { id: 's', language: 'chinese', title: '', text: sentence.text, paragraphs: [{ sentences: [sentence] }], groupBNames: [], focusedSentenceIndex: 0, status: 'in-progress' as const, createdAt: '', updatedAt: '', items: [
    ...items.map(i => i.id === source.id || i.kind === 'word' && i.range?.start === fixed.range.start && i.range.end === fixed.range.end ? { ...i, hiddenByRevision: 'conversion' } : i),
    { id: 'conversion-word', kind: 'word' as const, sentenceIndex: 0, order: 0, status: 'pending' as const, origin: 'manual' as const, edited: true,
      convertedFromGrammarId: source.id, term: fixed.lemma, sourceTerm: fixed.lemma, surface: fixed.surface, range: fixed.range, meaning: '手動の語義' },
  ] };
  const next = reconcileReadingSession(session);
  expect(sentenceItems(next.items, 0).words.some(i => i.id === 'conversion-word')).toBe(true);
  expect(sentenceItems(next.items, 0).grammar.some(i => i.id === source.id)).toBe(false);
  expect(readingConstructions(sentence, next.items).length).toBeGreaterThan(0);
  const rendered = readingOccurrences(sentence, next.items);
  const converted = rendered.find(o => o.range.start === fixed.range.start && o.range.end === fixed.range.end)!;
  expect(fixedGrammarOccurrenceIds(sentence, next.items, rendered).has(converted.id)).toBe(false);
  expect(next.items.length).toBe(session.items.length);
});
it('managed sentence explanations never add, remove or suppress editable candidates', () => {
  const items = fresh();
  const managed = { ...sentence, readingAnalysis: { ...sentence.readingAnalysis!, candidatesManaged: true } };
  const next = reconcileReadingSession({ id: 's', language: 'chinese', title: '', text: sentence.text, paragraphs: [{ sentences: [managed] }], groupBNames: [], focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '', items });
  expect(next.items).toEqual(items);
});
