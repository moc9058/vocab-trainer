import assert from "node:assert/strict";
import { test } from "node:test";
import { contextualDefinitions } from "./import-definitions.js";

const supplied = [{ partOfSpeech: "verb", text: { ja: "返す" } }, { partOfSpeech: "adverb", text: { ja: "まだ" } }];
test("source definitions follow explicit input indices even when the model reorders senses", () => {
  const result = contextualDefinitions([
    { inputDefinitionIndex: 1, partOfSpeech: "adverb", text: { en: "still" } },
    { inputDefinitionIndex: 0, partOfSpeech: "verb", text: { en: "return" } },
    { inputDefinitionIndex: null, partOfSpeech: "verb", text: { ja: "返す", en: "give back" }, distinctSenseReason: "paraphrase", contrastExample: "还书" },
    { inputDefinitionIndex: null, partOfSpeech: "verb", text: { en: "repay" } },
  ], supplied);
  assert.deepEqual(result.map(def => def.text.en), ["return", "still"]);
});
test("distinct established senses require both rationale and a contrasting example", () => {
  const result = contextualDefinitions([
    { inputDefinitionIndex: 0, partOfSpeech: "verb", text: { en: "return" }, pinyins: ["huán"] },
    { inputDefinitionIndex: null, partOfSpeech: "adverb", text: { en: "still" }, pinyins: ["hái"], distinctSenseReason: "continuation adverb rather than transitive return", contrastExample: "他还没来" },
  ], supplied.slice(0, 1));
  assert.equal(result.length, 2);
  assert.equal("distinctSenseReason" in result[1], false);
});
test("old config response remains usable without blindly appending extra paraphrases", () => {
  const result = contextualDefinitions([{ partOfSpeech: "verb", text: { en: "return" } }, { partOfSpeech: "verb", text: { en: "give back" } }], supplied.slice(0, 1));
  assert.equal(result.length, 1);
});
test("missing explicit anchor cannot accidentally copy another sense's translations", () => {
  const result = contextualDefinitions([{ inputDefinitionIndex: 1, partOfSpeech: "adverb", text: { en: "still" } }], supplied);
  assert.deepEqual(result[0].text, {});
});
