import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWordDefinitions, normalizeWordRecord, normalizeWordSession } from "./word-format.js";
import { cleanRetiredWordData, retiredWordDataChanged } from "./retired-word-data.js";

for (const language of ["chinese", "english", "japanese", "korean"]) {
  test(`${language}: legacy word fields are removed without losing meanings/readings`, () => {
    const original = { language, definitions: [{ partOfSpeech: "verb", text: { ja: "返す", en: "return" }, pinyins: ["huán"] }], grammaticalCategory: "verb", partOfSpeech: "verb", flag: true, topics: ["Education"], exampleIds: ["ex-1"] };
    const clean = normalizeWordRecord(original);
    assert.deepEqual(clean, { language, definitions: [{ text: { ja: "返す", en: "return" }, pinyins: ["huán"] }], topics: ["Education"], exampleIds: ["ex-1"] });
    assert.equal(original.definitions[0].partOfSpeech, "verb");
    assert.deepEqual(normalizeWordRecord(clean), clean);
  });
}
test("old single definition remains readable without grammaticalCategory", () => {
  assert.deepEqual(normalizeWordDefinitions({ definition: { en: "return" } }), [{ text: { en: "return" } }]);
});
test("session cleanup preserves grading, retries, reviews, groups and grammar descriptions", () => {
  const session = { flaggedOnly: true, status: "completed", score: { correct: 1, total: 2 }, reviewState: { cursor: 1 }, mixedScope: { wordA: ["a"] }, questions: [
    { kind: "word", wordId: "a", userCorrect: false, definitions: [{ partOfSpeech: "verb", text: { en: "return" } }] },
    { kind: "word", wordId: "a" },
    { kind: "grammar", grammarId: "g", descriptions: [{ partOfSpeech: "construction", text: { en: "pattern" } }] },
  ] };
  const clean = normalizeWordSession(session);
  assert.equal("flaggedOnly" in clean, false);
  assert.equal("partOfSpeech" in clean.questions[0].definitions![0], false);
  assert.deepEqual(clean.questions[2], session.questions[2]);
  assert.deepEqual(clean.score, session.score);
  assert.deepEqual(clean.reviewState, session.reviewState);
  assert.deepEqual(clean.mixedScope, session.mixedScope);
  assert.equal(clean.questions[0].userCorrect, false);
  assert.equal(clean.questions.length, 3);
  assert.equal(clean.status, "completed");
});
test("maintenance only alters allowlisted collections and is idempotent", () => {
  const data = { definitions: [{ partOfSpeech: "verb", text: { en: "return" } }], grammaticalCategory: "verb" };
  for (const collection of ["words", "word_drafts", "quiz_sessions", "combined_quiz_sessions"]) {
    const original = collection.endsWith("sessions") ? { flaggedOnly: true, questions: [data] } : data;
    assert.equal(retiredWordDataChanged(collection, original), true);
    assert.equal(retiredWordDataChanged(collection, cleanRetiredWordData(collection, original)!), false);
  }
  for (const collection of ["grammar_items", "grammar_drafts", "import_sessions", "archive_backups"]) assert.deepEqual(cleanRetiredWordData(collection, data), data);
  assert.equal(cleanRetiredWordData("flagged_words", { wordId: "a" }), null);
});
