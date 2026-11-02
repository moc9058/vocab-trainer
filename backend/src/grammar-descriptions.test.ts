import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeGrammarDescriptions, IncompleteGrammarDescriptionsError } from "./grammar-descriptions.js";

test("Korean and Japanese anchors are preserved verbatim with other languages and metadata", () => {
  const supplied = [
    { partOfSpeech: "construction", text: { ko: "  사용자가 쓴 설명  ", en: "Authored English" }, pinyins: ["bǎ"] },
    { partOfSpeech: "", text: { ja: "日本語の説明" } },
    { partOfSpeech: "", text: { ja: "両言語", ko: "두 언어" } },
  ];
  const generated = [
    { partOfSpeech: "wrong", text: { ja: "日本語訳", ko: "덮어쓰면 안 됨" } },
    { partOfSpeech: "wrong", text: { ja: "置き換えない", ko: "한국어 번역" } },
    { partOfSpeech: "wrong", text: { ja: "置き換えない", ko: "덮어쓰지 않음" } },
  ];
  const original = structuredClone(supplied);
  assert.deepEqual(mergeGrammarDescriptions(supplied, generated), [
    { partOfSpeech: "construction", text: { ko: "  사용자가 쓴 설명  ", en: "Authored English", ja: "日本語訳" }, pinyins: ["bǎ"] },
    { partOfSpeech: "", text: { ja: "日本語の説明", ko: "한국어 번역" } },
    { partOfSpeech: "", text: { ja: "両言語", ko: "두 언어" } },
  ]);
  assert.deepEqual(supplied, original);
});
test("blank entries are completed; missing or malformed translations fail before storage", () => {
  const supplied = [{ partOfSpeech: "", text: { ja: "説明", ko: " " } }];
  assert.equal(mergeGrammarDescriptions(supplied, [{ partOfSpeech: "", text: { ko: "번역" } }])[0].text.ko, "번역");
  for (const generated of [[], [{ partOfSpeech: "", text: { ko: " " } }], [{ partOfSpeech: "", text: { ko: 7 as unknown as string } }]]) {
    assert.throws(() => mergeGrammarDescriptions(supplied, generated), IncompleteGrammarDescriptionsError);
  }
});
