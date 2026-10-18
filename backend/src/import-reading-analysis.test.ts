import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeAnalysis, termOccurrences, lowercaseGrammarAbbreviations } from "./import-analysis.js";
import { sourceMatchesSentences, normalizeReadingSentence, type RawReadingSentence } from "./import-reading-analysis.js";

const raw = JSON.parse(readFileSync(new URL("./test-fixtures/import-context.json", import.meta.url), "utf8"));

test("contextual analysis preserves repeated occurrences and contextual polyphony without first-occurrence backfill", () => {
  const { analysis } = normalizeAnalysis(JSON.stringify(raw), "chinese");
  const gai = analysis.words.filter(word => word.term === "该");
  assert.deepEqual(gai.map(word => [word.range?.start, word.meaning]), [[0, "その"], [3, "そろそろ〜すべき"]]);
  assert.deepEqual(analysis.words.filter(word => word.term === "还").map(word => word.transliteration), ["hái", "huán"]);
  const grammar = analysis.grammar[0];
  assert.deepEqual(grammar.fixedElements?.map(word => word.surface), ["该", "了"]);
  assert.equal(grammar.fixedElements?.[0].range.start, 3);
  assert.equal(analysis.paragraphs[0].sentences[0].readingAnalysis?.explanationLanguage, "ja");
});

test("invalid ordinal and partially invalid fixed elements cannot suppress a candidate", () => {
  const sentence = structuredClone(raw.paragraphs[0].sentences[0]);
  sentence.words[2].occurrence = 99;
  sentence.grammar[0].elements[0].wordIndices = [0, 2];
  const { words, grammar } = normalizeReadingSentence(sentence, 0, termOccurrences, lowercaseGrammarAbbreviations);
  assert.equal(words.filter(word => word.term === "该").length, 1);
  assert.deepEqual(grammar[0].fixedElements?.map(word => word.surface), ["了"]);
});

test("positions use UTF-16 offsets and surface forms rather than inflected lemmas", () => {
  const sentence: RawReadingSentence = { text: "😀食べました。", overview: "test", words: [{ term: "食べる", surface: "食べました", occurrence: 0, meaning: "食事する" }], grammar: [] };
  const { reading, words } = normalizeReadingSentence(sentence, 7, termOccurrences, lowercaseGrammarAbbreviations);
  assert.deepEqual(reading.occurrences[0].range, { start: 2, end: 7 });
  assert.equal(words[0].term, "食べる");
  assert.equal(words[0].occurrenceId, "s7-o0");
});

test("a later blank contextual gloss never inherits an unrelated reading or sense", () => {
  const sentence = structuredClone(raw.paragraphs[1].sentences[0]);
  sentence.words[3].meaning = ""; sentence.words[3].transliteration = "";
  const { analysis } = normalizeAnalysis(JSON.stringify({ paragraphs: [{ sentences: [sentence] }] }), "chinese");
  assert.equal(analysis.words.filter(word => word.term === "还")[1].meaning, "");
});

test("long-article compact analysis retains contextual occurrences without duplicating detailed syntax in every sentence", () => {
  const compact = structuredClone(raw);
  for (const paragraph of compact.paragraphs) for (const sentence of paragraph.sentences) {
    delete sentence.overview; delete sentence.ambiguityNotes;
    for (const word of sentence.words) for (const key of ['role', 'reasoning', 'contrast', 'senseKey', 'partOfSpeech']) delete word[key];
    for (const grammar of sentence.grammar) { delete grammar.elements; delete grammar.roleInSentence; }
  }
  const { analysis } = normalizeAnalysis(JSON.stringify(compact), 'chinese');
  assert.equal(analysis.paragraphs[0].sentences[0].readingAnalysis, undefined);
  assert.deepEqual(analysis.words.filter(word => word.term === '还').map(word => word.transliteration), ['hái', 'huán']);
});

test("surface ordinals are case sensitive, while Latin word boundaries still hold", () => {
  const { reading } = normalizeReadingSentence({ text: 'A quick analysis and a test', overview: 'test', words: [
    { term: 'A', surface: 'A', occurrence: 0, meaning: 'article' },
    { term: 'a', surface: 'a', occurrence: 0, meaning: 'article' },
  ] }, 0, termOccurrences, lowercaseGrammarAbbreviations);
  assert.deepEqual(reading.occurrences.map(word => word.range.start), [0, 21]);
});

test("source validation rejects invented spaces, omissions and reordering while preserving paragraph boundaries", () => {
  assert.equal(sourceMatchesSentences("他买书。\n要下雨了。", ["他买书。", "要下雨了。"]), true);
  assert.equal(sourceMatchesSentences("他买书。", ["他 买书。"]), false);
  assert.equal(sourceMatchesSentences("他买书。要下雨了。", ["他买书。"]), false);
  assert.equal(sourceMatchesSentences("他买书。要下雨了。", ["要下雨了。", "他买书。"]), false);
});

test("noncontiguous fixed elements keep the intervening content words as separate slots", () => {
  const { reading, grammar } = normalizeReadingSentence({ text: '越学越懂。', overview: '程度が連動する', words: [
    { term: '越', surface: '越', occurrence: 0, transliteration: 'yuè', meaning: '〜するほど' },
    { term: '学', surface: '学', occurrence: 0, transliteration: 'xué', meaning: '学ぶ' },
    { term: '越', surface: '越', occurrence: 1, transliteration: 'yuè', meaning: 'ますます' },
    { term: '懂', surface: '懂', occurrence: 0, transliteration: 'dǒng', meaning: '理解する' },
  ], grammar: [{ statement: '越+v+越+v', description: '〜すればするほど〜', elements: [
    { wordIndices: [0, 2], role: '連動する程度', explanation: '二つの越が程度の連動を表す', fixed: true },
    { wordIndices: [1, 3], role: '動詞のスロット', explanation: '学ぶことと理解すること', fixed: false },
  ] }] }, 0, termOccurrences, lowercaseGrammarAbbreviations);
  assert.deepEqual(grammar[0].fixedElements?.map(word => word.range.start), [0, 2]);
  assert.deepEqual(reading.constructions[0].elements[1].occurrenceIds, ['s0-o1', 's0-o3']);
});

test("Chinese grammar requires pinyin on fixed elements and variable slot words", () => {
  for (const index of [2, 3, 5]) {
    const missing = structuredClone(raw.paragraphs[0].sentences[0]);
    missing.words[index].transliteration = " ";
    assert.throws(() => normalizeAnalysis(JSON.stringify({ paragraphs: [{ sentences: [missing] }] }), "chinese"), /IMPORT_GRAMMAR_PINYIN_MISSING/);
    assert.doesNotThrow(() => normalizeAnalysis(JSON.stringify({ paragraphs: [{ sentences: [missing] }] }), "japanese"));
  }
  const latin = structuredClone(raw.paragraphs[0].sentences[0]);
  latin.text = latin.text.replace('采取', 'take');
  latin.words[3].term = 'take'; latin.words[3].surface = 'take'; latin.words[3].transliteration = '';
  assert.doesNotThrow(() => normalizeAnalysis(JSON.stringify({ paragraphs: [{ sentences: [latin] }] }), "chinese"));
});

test('whole sentence nuance evidence must be an exact nonempty source excerpt', () => {
  const raw = { text: '他倒是答应了。', explanationLanguage: 'ja', words: [], grammar: [], overview: '承諾はした', comprehension: { meaning: '承諾はした', skeleton: '彼が承諾した', connection: '不明', nuances: [{ text: '譲歩', evidence: '倒是', certainty: 'inferred' as const }] } };
  const valid = normalizeReadingSentence(raw, 0, (text, term) => text.includes(term) ? [text.indexOf(term)] : [], s => s);
  assert.equal(valid.reading.comprehension!.nuances[0].evidence, '倒是');
  assert.throws(() => normalizeReadingSentence({ ...raw, comprehension: { ...raw.comprehension, nuances: [{ ...raw.comprehension.nuances[0], evidence: '不存在' }] } }, 0, () => [], s => s), /evidence/);
});
