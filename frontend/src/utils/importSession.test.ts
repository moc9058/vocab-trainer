import { describe, expect, it } from "vitest";
import { extractStreamingSentences } from "../api/import";
import {
  buildImportItems,
  claimedGrammarIds,
  findWordHome,
  isLive,
  libraryClaimTerms,
  mismatchedWords,
  reattachMismatchedWords,
  reconcileLibraryClaims,
  registeredTerms,
  requiresVerbatimTerms,
  sentenceCoverage,
  sentenceItems,
  wordMismatch,
} from "./importSession";
import type {
  ImportAnalysisResult,
  ImportGrammarItem,
  ImportItem,
  ImportSentence,
  ImportWordItem,
} from "../types";

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

  it("does not let a trailing digit break the acronym's boundary", () => {
    // 「实现GDP19843亿元」 — Chinese runs the number straight onto the acronym.
    expect(wordMismatch("深圳实现GDP19843亿元", "GDP", "chinese")).toBe(false);
    // The English case the boundary rule exists for still holds.
    expect(wordMismatch("a quick analysis", "analys", "english")).toBe(true);
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

function grammarItem(
  statement: string,
  sentenceIndex: number,
  extra: Partial<ImportGrammarItem> = {}
): ImportGrammarItem {
  return {
    id: `g${seq++}`,
    kind: "grammar",
    sentenceIndex,
    order: 0,
    status: "pending",
    origin: "llm",
    statement,
    description: "",
    ...extra,
  };
}

describe("libraryClaimTerms", () => {
  it("collects every row that claims library presence, tombstone ids included", () => {
    const items: ImportItem[] = [
      wordItem("重庆", 0, { existingWordId: "42" }),
      wordItem("广州", 0, { status: "registered" }),
      wordItem("差距", 0, { status: "duplicate" }),
      wordItem("缩小", 0, { status: "queued" }),
      // A tombstone with an id still poisons `inLibrary` via registeredTerms.
      wordItem("经济", 0, { status: "skipped", existingWordId: "7" }),
      // A tombstone without one claims nothing.
      wordItem("人口", 0, { status: "skipped" }),
      wordItem("规模", 0),
      // Dedupes after trimming.
      wordItem(" 重庆 ", 1, { existingWordId: "42" }),
      // Not lookupable server-side — sending it would make "never checked"
      // indistinguishable from "absent".
      wordItem("……", 0, { existingWordId: "9" }),
      wordItem("", 0, { existingWordId: "9" }),
    ];
    expect(libraryClaimTerms(items).sort()).toEqual(
      ["差距", "广州", "经济", "缩小", "重庆"].sort()
    );
  });
});

describe("reconcileLibraryClaims", () => {
  const checked = (...checkedTerms: string[]) => new Set(checkedTerms);
  const absent = (...checkedTerms: string[]) => ({
    wordIdByTerm: {},
    checkedTerms: checked(...checkedTerms),
    liveGrammarIds: null,
  });

  it("resets a registered row whose word was deleted", () => {
    const items = [
      wordItem("重庆", 0, {
        existingWordId: "42",
        status: "registered",
        target: "A",
        registrations: { A: { status: "registered" } },
      }),
    ];
    const { items: out, changed } = reconcileLibraryClaims(items, absent("重庆"));
    expect(changed).toBe(true);
    const row = out[0] as ImportWordItem;
    expect(row.existingWordId).toBeUndefined();
    expect(row.registrations).toBeUndefined();
    expect(row.status).toBe("pending");
    expect(row.target).toBeUndefined();
    // The row no longer reads as "in the library".
    expect(registeredTerms(out).has("重庆")).toBe(false);
  });

  it("keeps a failed slot and its error while pruning the disproved one", () => {
    const items = [
      wordItem("广州", 0, {
        existingWordId: "43",
        status: "failed",
        target: "B",
        error: "boom",
        registrations: {
          A: { status: "registered" },
          B: { status: "failed", error: "boom" },
        },
      }),
    ];
    const { items: out } = reconcileLibraryClaims(items, absent("广州"));
    const row = out[0] as ImportWordItem;
    expect(row.existingWordId).toBeUndefined();
    expect(row.registrations).toEqual({ B: { status: "failed", error: "boom" } });
    expect(row.status).toBe("failed");
    expect(row.target).toBe("B");
    expect(row.error).toBe("boom");
  });

  it("drops a dead tab's queued slot rather than leaving the row locked", () => {
    const items = [
      wordItem("缩小", 0, {
        status: "queued",
        target: "A",
        registrations: { A: { status: "queued" } },
      }),
    ];
    const { items: out } = reconcileLibraryClaims(items, absent("缩小"));
    const row = out[0] as ImportWordItem;
    expect(row.status).toBe("pending");
    expect(row.registrations).toBeUndefined();
  });

  it("only strips the id from a tombstone — skipped is the user's decision", () => {
    const items = [wordItem("经济", 0, { status: "skipped", existingWordId: "7" })];
    const { items: out, changed } = reconcileLibraryClaims(items, absent("经济"));
    expect(changed).toBe(true);
    const row = out[0] as ImportWordItem;
    expect(row.status).toBe("skipped");
    expect(row.existingWordId).toBeUndefined();
  });

  it("settles a queued row whose write is proven to have landed", () => {
    const items = [
      wordItem("重庆", 0, {
        status: "queued",
        target: "A",
        registrations: { A: { status: "queued" }, B: { status: "registered" } },
      }),
      // Legacy row without a registrations record.
      wordItem("广州", 0, { status: "queued" }),
    ];
    const { items: out } = reconcileLibraryClaims(items, {
      wordIdByTerm: { "重庆": "42", "广州": "43" },
      checkedTerms: checked("重庆", "广州"),
      liveGrammarIds: null,
    });
    const first = out[0] as ImportWordItem;
    expect(first.existingWordId).toBe("42");
    expect(first.status).toBe("registered");
    expect(first.registrations?.A).toEqual({ status: "registered" });
    const second = out[1] as ImportWordItem;
    expect(second.existingWordId).toBe("43");
    expect(second.status).toBe("registered");
  });

  it("refreshes an id that changed under a delete-then-recreate", () => {
    const items = [wordItem("重庆", 0, { existingWordId: "42" })];
    const { items: out, changed } = reconcileLibraryClaims(items, {
      wordIdByTerm: { "重庆": "77" },
      checkedTerms: checked("重庆"),
      liveGrammarIds: null,
    });
    expect(changed).toBe(true);
    expect((out[0] as ImportWordItem).existingWordId).toBe("77");
  });

  it("never touches what was not probed", () => {
    const items = [
      wordItem("重庆", 0, { existingWordId: "42", status: "registered" }),
      grammarItem("随着～，越来越～", 0, { existingGrammarId: "g1", status: "registered" }),
    ];
    const { items: out, changed } = reconcileLibraryClaims(items, {
      wordIdByTerm: {},
      checkedTerms: new Set<string>(),
      liveGrammarIds: null,
    });
    expect(changed).toBe(false);
    expect(out).toBe(items);
  });

  it("reconciles grammar claims by id", () => {
    const items = [
      grammarItem("随着～，越来越～", 0, {
        existingGrammarId: "g1",
        status: "registered",
        registrations: { A: { status: "registered" } },
      }),
      grammarItem("越～越～", 0, { existingGrammarId: "g2", status: "registered" }),
    ];
    expect(claimedGrammarIds(items).sort()).toEqual(["g1", "g2"]);
    const { items: out } = reconcileLibraryClaims(items, {
      wordIdByTerm: {},
      checkedTerms: new Set<string>(),
      liveGrammarIds: new Set(["g2"]),
    });
    const gone = out[0] as ImportGrammarItem;
    expect(gone.existingGrammarId).toBeUndefined();
    expect(gone.status).toBe("pending");
    expect(gone.registrations).toBeUndefined();
    expect(out[1]).toBe(items[1]);
  });

  it("is idempotent — the second run reports no change and returns the same array", () => {
    const items = [
      wordItem("重庆", 0, {
        existingWordId: "42",
        status: "registered",
        registrations: { A: { status: "registered" } },
      }),
      wordItem("经济", 0, { status: "skipped", existingWordId: "7" }),
    ];
    const input = absent("重庆", "经济");
    const first = reconcileLibraryClaims(items, input);
    expect(first.changed).toBe(true);
    const second = reconcileLibraryClaims(first.items, input);
    expect(second.changed).toBe(false);
    expect(second.items).toBe(first.items);
  });
});
