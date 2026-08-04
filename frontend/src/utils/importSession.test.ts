import { describe, expect, it } from "vitest";
import { extractStreamingSentences } from "../api/import";
import {
  buildImportItems,
  findWordHome,
  isLive,
  mismatchedWords,
  reattachMismatchedWords,
  requiresVerbatimTerms,
  sentenceCoverage,
  sentenceItems,
  wordMismatch,
} from "./importSession";
import type { ImportAnalysisResult, ImportItem, ImportSentence, ImportWordItem } from "../types";

// The sentence from the bug report, plus the one the stray words really came from.
const GDP = "在2025年上半年，重庆与广州的GDP差距约为849亿元，一年间缩小约191亿元。";
const ADMIN = "重庆的行政区划和人口规模与广州不同。";

function sentences(...texts: string[]): ImportSentence[] {
  return texts.map((text, index) => ({ index, text }));
}

let seq = 0;
function wordItem(
  term: string,
  sentenceIndex: number,
  extra: Partial<ImportWordItem> = {}
): ImportWordItem {
  return {
    id: `w${seq++}`,
    kind: "word",
    sentenceIndex,
    order: 0,
    status: "pending",
    origin: "llm",
    term,
    ...extra,
  };
}

const terms = (items: ImportItem[], sentenceIndex: number) =>
  sentenceItems(items, sentenceIndex).words.map((w) => w.term);

describe("sentenceCoverage", () => {
  it("lets a Chinese sentence stay exact when a misattributed word shares a character", () => {
    // 「一带一路」 is not in this sentence, but its one-character prefix 「一」 is (一年间).
    // The old code covered that character and flagged the whole sentence approximate,
    // which made materializeGaps refuse to run — one misfiled word silently voided the
    // "every character has a row" guarantee.
    const coverage = sentenceCoverage(GDP, [wordItem("一带一路", 0)], "chinese");
    expect(coverage.approximate).toBe(false);
    expect(coverage.missing).toBe(coverage.required);
  });

  it("still covers a Japanese inflection through its prefix", () => {
    const coverage = sentenceCoverage("ご飯を食べました。", [wordItem("食べる", 0)], "japanese");
    expect(coverage.approximate).toBe(true);
    // 食べ — two of the sentence's characters are now accounted for.
    expect(coverage.required - coverage.missing).toBe(2);
  });

  it("refuses a one-character prefix even in Japanese", () => {
    // A single character matches almost anything, so it is not evidence of inflection.
    const coverage = sentenceCoverage("猫が鳴いた。", [wordItem("猫だ", 0)], "japanese");
    expect(coverage.approximate).toBe(false);
  });

  it("ignores punctuation and digits when counting what must be covered", () => {
    expect(sentenceCoverage("849亿元。", [wordItem("亿元", 0)], "chinese").complete).toBe(true);
  });
});

describe("wordMismatch", () => {
  it("flags a Chinese term that is not in the sentence", () => {
    expect(wordMismatch(GDP, "行政区划", "chinese")).toBe(true);
    expect(wordMismatch(GDP, "差距", "chinese")).toBe(false);
  });

  it("forgives a Japanese inflection but not an unrelated word", () => {
    expect(wordMismatch("ご飯を食べました。", "食べる", "japanese")).toBe(false);
    expect(wordMismatch("ご飯を食べました。", "自動車", "japanese")).toBe(true);
  });

  it("does not flag an empty row the user has yet to fill in", () => {
    expect(wordMismatch(GDP, "  ", "chinese")).toBe(false);
  });

  it("does not flag a Latin acronym embedded in Chinese", () => {
    // A Han character is a letter, so a `\p{L}` boundary test would report 「GDP」 as
    // absent from a sentence that plainly contains it — flagging it rose and
    // refusing its registration.
    expect(wordMismatch(GDP, "GDP", "chinese")).toBe(false);
    expect(wordMismatch("制造业PMI为49.3%", "PMI", "chinese")).toBe(false);
  });

  it("still counts an acronym towards coverage", () => {
    expect(sentenceCoverage("制造业PMI为", [wordItem("PMI", 0)], "chinese").covered[3]).toBe(true);
  });

  it("only treats absence as a verdict where terms must be verbatim", () => {
    expect(requiresVerbatimTerms("chinese")).toBe(true);
    expect(requiresVerbatimTerms("english")).toBe(true);
    expect(requiresVerbatimTerms("japanese")).toBe(false);
    expect(requiresVerbatimTerms("korean")).toBe(false);
  });
});

describe("findWordHome", () => {
  it("returns the sentence the term occurs in, with its offset", () => {
    expect(findWordHome("行政区划", 0, sentences(GDP, ADMIN), "chinese")).toEqual({
      index: 1,
      at: 3,
    });
  });

  it("prefers the nearest sentence, ties going to the lower index", () => {
    const pool = sentences("甲。", "乙。", "丙。", "乙。");
    expect(findWordHome("乙", 2, pool, "chinese")?.index).toBe(1);
  });

  it("returns null when nothing matches", () => {
    expect(findWordHome("宇宙飛行士", 0, sentences(GDP, ADMIN), "chinese")).toBeNull();
  });
});

describe("reattachMismatchedWords", () => {
  it("moves a misfiled row to the sentence it belongs to", () => {
    const items = [wordItem("差距", 0), wordItem("行政区划", 0)];
    const next = reattachMismatchedWords(items, sentences(GDP, ADMIN), "chinese");
    expect(terms(next, 0)).not.toContain("行政区划");
    expect(terms(next, 0)).toContain("差距");
    expect(terms(next, 1)).toEqual(["行政区划"]);
  });

  it("tombstones the row instead when its destination already lists the term", () => {
    const items = [wordItem("行政区划", 0), wordItem("行政区划", 1)];
    const next = reattachMismatchedWords(items, sentences(GDP, ADMIN), "chinese");
    const live = next.filter(
      (i): i is ImportWordItem => isLive(i) && i.kind === "word" && i.term === "行政区划"
    );
    expect(live).toHaveLength(1);
    expect(live[0].sentenceIndex).toBe(1);
    expect(next.find((i) => i.id === items[0].id)?.status).toBe("skipped");
  });

  it("leaves a row that matches no sentence where it is, still flagged", () => {
    const pool = sentences(GDP, ADMIN);
    const items = [wordItem("宇宙飛行士", 0)];
    const next = reattachMismatchedWords(items, pool, "chinese");
    expect(next[0].sentenceIndex).toBe(0);
    expect(mismatchedWords(next, pool, "chinese")).toHaveLength(1);
  });

  it("never moves a row that has already been registered", () => {
    // Its example sentence is already in the database; moving it now would make the
    // session claim it was registered from a sentence it never saw.
    const items = [wordItem("行政区划", 0, { status: "registered" })];
    const next = reattachMismatchedWords(items, sentences(GDP, ADMIN), "chinese");
    expect(next[0].sentenceIndex).toBe(0);
  });

  it("re-materializes gaps only for the sentence the row left", () => {
    // A session saved under the old rules: the sentence was flagged approximate by the
    // intruder, so its gap rows were never created. Removing the intruder is what lets
    // the coverage guarantee be restored.
    const pool = sentences("重庆与广州的差距。", "重庆的行政区划。");
    const items = [wordItem("重庆", 0), wordItem("与", 0), wordItem("行政区划", 0)];
    const next = reattachMismatchedWords(items, pool, "chinese");

    expect(terms(next, 1)).toEqual(["行政区划"]);
    // 广州的差距 was uncovered and now has a row of its own.
    expect(terms(next, 0)).toContain("广州的差距");
    expect(sentenceItems(next, 0).words.find((w) => w.origin === "gap")).toBeTruthy();
    // The sentence it moved INTO cannot have lost coverage, so it gains no gap row.
    expect(sentenceItems(next, 1).words.every((w) => w.origin !== "gap")).toBe(true);
  });

  it("repairs a single row when given an id", () => {
    const items = [wordItem("行政区划", 0), wordItem("人口规模", 0)];
    const next = reattachMismatchedWords(items, sentences(GDP, ADMIN), "chinese", items[0].id);
    expect(next[0].sentenceIndex).toBe(1);
    expect(next[1].sentenceIndex).toBe(0);
  });
});

describe("extractStreamingSentences", () => {
  it("still reads only sentence texts once words are nested inside them", () => {
    // The preview scrapes `"text"` out of the partial stream. Nesting adds word and
    // grammar objects between sentences, and none of their fields is called `text` —
    // which is the whole reason the restructure did not need a new preview parser.
    const partial = `{"paragraphs":[{"sentences":[
      {"text":"他的书。","translation":"彼の本。",
       "words":[{"term":"他","transliteration":"tā","meaning":"彼"}],
       "grammar":[{"statement":"n＋的＋n","description":"連体修飾","excerpt":"他的书"}]},
      {"text":"我来了。","transl`;
    expect(extractStreamingSentences(partial)).toEqual(["他的书。", "我来了。"]);
  });
});

describe("buildImportItems", () => {
  const analysis: ImportAnalysisResult = {
    paragraphs: [{ sentences: sentences(GDP, ADMIN) }],
    words: [
      { term: "差距", sentenceIndex: 0 },
      // The reported symptom: a word from another sentence, filed under the GDP one.
      { term: "行政区划", sentenceIndex: 0 },
      { term: "重庆", sentenceIndex: 1 },
    ],
    grammar: [
      { statement: "n＋与＋n", description: "比較", excerpt: "重庆与广州", sentenceIndex: 0 },
    ],
  };

  it("flags the misattributed row rather than letting it pass as a normal word", () => {
    const items = buildImportItems(analysis, {}, {}, "chinese");
    const flagged = mismatchedWords(items, sentences(GDP, ADMIN), "chinese");
    expect(flagged.map((w) => w.term)).toEqual(["行政区划"]);
  });

  it("still materializes the GDP sentence's gaps despite the intruder", () => {
    const items = buildImportItems(analysis, {}, {}, "chinese");
    const words = sentenceItems(items, 0).words;
    expect(words.some((w) => w.origin === "gap")).toBe(true);
    // Every character that needs covering now has a row behind it.
    expect(sentenceCoverage(GDP, words, "chinese").complete).toBe(true);
  });

  it("carries the grammar excerpt onto the row", () => {
    const items = buildImportItems(analysis, {}, {}, "chinese");
    const grammar = sentenceItems(items, 0).grammar;
    expect(grammar[0].excerpt).toBe("重庆与广州");
  });

  it("orders word rows by where the term starts in the sentence", () => {
    const items = buildImportItems(
      {
        paragraphs: [{ sentences: sentences("重庆与广州") }],
        // Deliberately out of sentence order — array order must not decide the layout.
        words: [
          { term: "广州", sentenceIndex: 0 },
          { term: "重庆", sentenceIndex: 0 },
          { term: "与", sentenceIndex: 0 },
        ],
        grammar: [],
      },
      {},
      {},
      "chinese"
    );
    expect(terms(items, 0)).toEqual(["重庆", "与", "广州"]);
  });
});
