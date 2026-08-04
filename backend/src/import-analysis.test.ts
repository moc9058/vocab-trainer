import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backfillRepeatedWords,
  normalizeAnalysis,
  repairGrammarAttribution,
  repairWordAttribution,
  termOccurrences,
} from "./import-analysis.js";
import type { ImportSentence } from "./types.js";

// The sentence from the bug report, plus the one the stray words really came from.
const GDP = "在2025年上半年，重庆与广州的GDP差距约为849亿元，一年间缩小约191亿元。";
const ADMIN = "重庆的行政区划和人口规模与广州不同。";

function sentences(...texts: string[]): ImportSentence[] {
  return texts.map((text, index) => ({ index, text }));
}

function word(term: string, sentenceIndex: number, extra: Record<string, string> = {}) {
  return { term, sentenceIndex, ...extra };
}

// ---------- termOccurrences ----------

test("termOccurrences finds every occurrence of a CJK term", () => {
  assert.deepEqual(termOccurrences("约为849亿元，缩小约191亿元", "约"), [0, 10]);
});

test("termOccurrences matches a Latin term only at word boundaries", () => {
  // Without the boundary rule the article "a" matches inside "analysis" and coverage
  // is so over-claimed that no English sentence ever reports a gap.
  assert.deepEqual(termOccurrences("A quick analysis", "a"), [0]);
  assert.deepEqual(termOccurrences("the analysis", "analys"), []);
});

test("a Latin acronym embedded in Chinese still counts as present", () => {
  // A Han character is a letter, so a `\p{L}` boundary test would leave 「GDP」 with
  // no valid boundary anywhere in this sentence — and the occurrence check now
  // decides whether to DROP the row, which would delete real vocabulary.
  assert.deepEqual(termOccurrences(GDP, "GDP"), [16]);
  assert.deepEqual(termOccurrences("制造业PMI为49.3%", "PMI"), [3]);
});

test("a digit does not break a Latin term's boundary", () => {
  // Chinese runs the number straight onto the acronym. Treating the digit as a
  // boundary made a legitimate 「GDP」 row look absent, so it was moved to another
  // sentence, found redundant there, and DROPPED — with a gap row left in its place.
  assert.deepEqual(termOccurrences("深圳实现GDP19843亿元", "GDP"), [4]);
  assert.deepEqual(termOccurrences("制造业PMI49.3%", "PMI"), [3]);
  // The rule it exists for still holds.
  assert.deepEqual(termOccurrences("a quick analysis", "a"), [0]);
});

test("a Chinese sentence's Latin acronym is never dropped as absent", () => {
  const { words, summary } = repairWordAttribution(
    [word("GDP", 0), word("差距", 0)],
    sentences(GDP, ADMIN),
    "chinese"
  );
  assert.deepEqual(words.map((w) => [w.term, w.sentenceIndex]), [
    ["GDP", 0],
    ["差距", 0],
  ]);
  assert.equal(summary.dropped, 0);
});

// ---------- repairWordAttribution ----------

test("moves a Chinese word onto the sentence it actually occurs in", () => {
  const { words, summary } = repairWordAttribution(
    [word("行政区划", 0), word("人口规模", 0), word("差距", 0)],
    sentences(GDP, ADMIN),
    "chinese"
  );
  assert.deepEqual(
    words.map((w) => [w.term, w.sentenceIndex]),
    [
      ["行政区划", 1],
      ["人口规模", 1],
      ["差距", 0],
    ]
  );
  assert.equal(summary.reassigned, 2);
  assert.equal(summary.dropped, 0);
});

test("drops a Chinese word that occurs nowhere in the article", () => {
  // Nothing is lost: `materializeGaps` re-surfaces the sentence's own characters as
  // rows client-side, so the coverage guarantee still holds.
  const { words, summary } = repairWordAttribution(
    [word("差距", 0), word("宇宙飛行士", 0)],
    sentences(GDP, ADMIN),
    "chinese"
  );
  assert.deepEqual(words.map((w) => w.term), ["差距"]);
  assert.equal(summary.dropped, 1);
});

test("drops a moved word when its destination already lists the term", () => {
  const { words, summary } = repairWordAttribution(
    // Sentence 1 already lists 行政区划 correctly; the stray copy filed under 0 is a
    // duplicate there, not a rescue.
    [word("行政区划", 0), word("行政区划", 1)],
    sentences(GDP, ADMIN),
    "chinese"
  );
  assert.deepEqual(words.map((w) => w.sentenceIndex), [1]);
  assert.equal(summary.redundant, 1);
  assert.equal(summary.reassigned, 0);
});

test("a correctly-filed row is never displaced by a misfiled one", () => {
  // The misfiled row comes FIRST in the array. A one-pass repair would let it claim
  // sentence 1 and then drop the legitimate row — which is the one carrying the gloss.
  const { words } = repairWordAttribution(
    [word("行政区划", 0), word("行政区划", 1, { meaning: "行政区分" })],
    sentences(GDP, ADMIN),
    "chinese"
  );
  assert.equal(words.length, 1);
  assert.equal(words[0].meaning, "行政区分");
});

test("nearest sentence wins, ties going to the lower index", () => {
  const pool = sentences("甲。", "乙。", "丙。", "乙。");
  // 「乙」 occurs at 1 and 3; a row filed under 2 is equidistant from both.
  const { words } = repairWordAttribution([word("乙", 2)], pool, "chinese");
  assert.equal(words[0].sentenceIndex, 1);
});

test("Japanese keeps an inflected term on its own sentence", () => {
  // 食べる does not occur verbatim in 「食べました」, and must NOT be moved to the other
  // sentence that happens to spell it out — the prefix in its own sentence wins.
  const { words, summary } = repairWordAttribution(
    [word("食べる", 0)],
    sentences("ご飯を食べました。", "毎日食べる。"),
    "japanese"
  );
  assert.equal(words[0].sentenceIndex, 0);
  assert.equal(summary.reassigned, 0);
  assert.equal(summary.dropped, 0);
});

test("Japanese never drops a word that matches nothing", () => {
  const { words, summary } = repairWordAttribution(
    [word("ぜんぜん違う", 0)],
    sentences("ご飯を食べました。"),
    "japanese"
  );
  assert.equal(words.length, 1);
  assert.equal(summary.unmatched, 1);
  assert.equal(summary.dropped, 0);
});

test("Korean moves a term to a sentence that spells it out", () => {
  const { words } = repairWordAttribution(
    [word("경제", 1)],
    sentences("경제가 성장했다.", "날씨가 좋다."),
    "korean"
  );
  assert.equal(words[0].sentenceIndex, 0);
});

test("a term with no letter at all is dropped, whatever the language", () => {
  // The prompts already exclude digits and punctuation from segmentation; before
  // this rule a symbols-only row survived as long as it occurred verbatim, and
  // ended up in a Firestore document path via the segment lookup.
  const { words, summary } = repairWordAttribution(
    [word("2025", 0), word("……", 0), word("/", 0), word("行政区划", 1)],
    sentences(GDP, ADMIN),
    "chinese"
  );
  assert.deepEqual(words.map((w) => w.term), ["行政区划"]);
  assert.equal(summary.nonLexical, 3);
  assert.equal(summary.dropped, 0, "a non-lexical drop is not a not-in-the-article drop");
});

test("a term keeps digits and symbols as long as it holds a letter", () => {
  const article = "阿里巴巴（09988.HK/NYSE : BABA）发布了新一代产品。";
  const { words, summary } = repairWordAttribution(
    [word("09988.HK/NYSE", 0), word("新一代", 0)],
    sentences(article),
    "chinese"
  );
  assert.deepEqual(words.map((w) => w.term), ["09988.HK/NYSE", "新一代"]);
  assert.equal(summary.nonLexical, 0);
});

// ---------- grammar ----------

test("grammar follows its excerpt to the right sentence", () => {
  const { grammar, summary } = repairGrammarAttribution(
    [{ statement: "n＋与＋n", description: "比較", excerpt: "重庆与广州", sentenceIndex: 1 }],
    sentences(GDP, ADMIN)
  );
  assert.equal(grammar[0].sentenceIndex, 0);
  assert.equal(summary.reassigned, 1);
});

test("grammar with an unfindable excerpt is kept, with the excerpt cleared", () => {
  // Dropping the pattern would cost real teaching material; grammar never affects
  // sentence coverage, so a wrong attachment is the cheaper failure.
  const { grammar, summary } = repairGrammarAttribution(
    [{ statement: "把＋o＋v", description: "処置文", excerpt: "把书放", sentenceIndex: 0 }],
    sentences(GDP, ADMIN)
  );
  assert.equal(grammar.length, 1);
  assert.equal(grammar[0].excerpt, undefined);
  assert.equal(summary.unmatched, 1);
});

// ---------- backfillRepeatedWords ----------

test("a blank reading and gloss inherit from the term's first occurrence", () => {
  const filled = backfillRepeatedWords([
    word("的", 0, { transliteration: "de", meaning: "〜の" }),
    word("的", 2, { transliteration: "", meaning: "" }),
  ]);
  assert.equal(filled[1].transliteration, "de");
  assert.equal(filled[1].meaning, "〜の");
});

test("the two fields inherit independently", () => {
  const filled = backfillRepeatedWords([
    word("了", 0, { transliteration: "le", meaning: "" }),
    word("了", 1, { transliteration: "", meaning: "完了" }),
    word("了", 2, { transliteration: "", meaning: "" }),
  ]);
  assert.equal(filled[2].transliteration, "le");
  assert.equal(filled[2].meaning, "完了");
});

// ---------- normalizeAnalysis ----------

const NESTED = JSON.stringify({
  paragraphs: [
    {
      sentences: [
        {
          text: "他的书。",
          translation: "彼の本。",
          words: [
            { term: "他", transliteration: "tā", meaning: "彼" },
            { term: "的", transliteration: "de", meaning: "〜の" },
            { term: "书", transliteration: "shū", meaning: "本" },
          ],
          grammar: [],
        },
      ],
    },
    {
      sentences: [
        {
          text: "这是我的。",
          translation: "これは私のだ。",
          words: [
            { term: "这", transliteration: "zhè", meaning: "これ" },
            { term: "是", transliteration: "shì", meaning: "である" },
            { term: "我", transliteration: "wǒ", meaning: "私" },
            { term: "的", transliteration: "", meaning: "" },
          ],
          grammar: [{ statement: "S＋是＋O", description: "判断文", excerpt: "这是我的" }],
        },
      ],
    },
  ],
});

test("nested words take their sentence index from their position", () => {
  const { analysis } = normalizeAnalysis(NESTED, "chinese");
  assert.deepEqual(
    analysis.paragraphs.flatMap((p) => p.sentences).map((s) => s.index),
    [0, 1]
  );
  assert.deepEqual(
    analysis.words.map((w) => [w.term, w.sentenceIndex]),
    [
      ["他", 0],
      ["的", 0],
      ["书", 0],
      ["这", 1],
      ["是", 1],
      ["我", 1],
      ["的", 1],
    ]
  );
});

test("indices continue across paragraph boundaries", () => {
  const { analysis } = normalizeAnalysis(NESTED, "chinese");
  assert.equal(analysis.paragraphs[1].sentences[0].index, 1);
});

test("nesting still backfills a repeated word, and lowercases grammar abbreviations", () => {
  const { analysis } = normalizeAnalysis(NESTED, "chinese");
  const second = analysis.words.filter((w) => w.term === "的")[1];
  assert.equal(second.transliteration, "de");
  assert.equal(analysis.grammar[0].statement, "s＋是＋o");
});

test("the pre-nesting flat shape is still accepted", () => {
  // `config/import` is pushed separately from the code, so a local emulator can be
  // holding an older snapshot of the schema and prompts.
  const legacy = JSON.stringify({
    paragraphs: [{ sentences: [{ text: GDP }, { text: ADMIN }] }],
    words: [word("差距", 0), word("行政区划", 0)],
    grammar: [{ statement: "n＋与＋n", description: "比較", sentenceIndex: 0 }],
  });
  const { analysis, repair } = normalizeAnalysis(legacy, "chinese");
  assert.deepEqual(
    analysis.words.map((w) => [w.term, w.sentenceIndex]),
    [
      ["差距", 0],
      ["行政区划", 1],
    ]
  );
  assert.equal(repair.reassigned, 1);
});

test("normalizeAnalysis surfaces non-lexical drops in the repair summary", () => {
  const nested = JSON.stringify({
    paragraphs: [
      {
        sentences: [
          {
            text: "阿里巴巴（09988.HK/NYSE : BABA）发布了新一代产品。",
            translation: "アリババが新世代の製品を発表した。",
            words: [
              { term: "阿里巴巴", transliteration: "Ālǐbābā", meaning: "アリババ" },
              { term: "09988.HK/NYSE", transliteration: "", meaning: "銘柄コード" },
              { term: "：", transliteration: "", meaning: "" },
              { term: "新一代", transliteration: "xīn yī dài", meaning: "新世代" },
            ],
            grammar: [],
          },
        ],
      },
    ],
  });
  const { analysis, repair } = normalizeAnalysis(nested, "chinese");
  assert.deepEqual(
    analysis.words.map((w) => w.term),
    ["阿里巴巴", "09988.HK/NYSE", "新一代"]
  );
  assert.equal(repair.nonLexical, 1);
});

test("a dropped bogus row is never the occurrence others inherit from", () => {
  // Repair runs BEFORE backfill, so a reading carried by a row that gets discarded
  // cannot leak onto the legitimate rows for the same term. The bogus row is FIRST,
  // which is exactly the position backfill inherits from.
  const legacy = JSON.stringify({
    paragraphs: [{ sentences: [{ text: "很好。" }, { text: "他来了。" }] }],
    words: [
      // 好 does not occur in sentence 1 at all; its home (sentence 0) already lists
      // the term, so this row is redundant and is dropped.
      { term: "好", sentenceIndex: 1, transliteration: "WRONG", meaning: "wrong" },
      { term: "好", sentenceIndex: 0, transliteration: "", meaning: "" },
    ],
  });
  const { analysis } = normalizeAnalysis(legacy, "chinese");
  const surviving = analysis.words.filter((w) => w.term === "好");
  assert.equal(surviving.length, 1);
  assert.ok(!surviving[0].transliteration, "the discarded row's reading must not be inherited");
});

test("a truncated response reports the over-long-article error", () => {
  assert.throws(
    () => normalizeAnalysis('{"paragraphs": [{"sentences": [{"text": "他', "chinese"),
    /did not come back as complete JSON/
  );
});
