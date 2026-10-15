import { expect, it } from "vitest";
import fixture from "./__fixtures__/import-context.json";
import type { ImportAnalysisResult, ImportItem } from "../types";
import { buildImportItems, materializeGaps, sentenceCoverage, sentenceItems, splitWordItem, undoDerivation } from "./importSession";
import { readingOccurrences, readingConstructions, validReading } from "./importReadingAnalysis";

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
