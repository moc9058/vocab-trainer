import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Firestore } from "@google-cloud/firestore";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("An explicit emulator is required");
process.env.FIRESTORE_PROJECT = `retired-word-test-${Date.now()}`;
process.env.FIRESTORE_DATABASE_ID = "vocab-database";
const db = new Firestore({ projectId: process.env.FIRESTORE_PROJECT, databaseId: "vocab-database" });
const actualLLM = await import("../../../src/llm.js");
mock.module("../../../src/llm.js", { namedExports: {
  ...actualLLM,
  callLLM: async () => JSON.stringify({ transliteration: "test", definitions: [{ partOfSpeech: "verb", text: { en: "test", ja: "試験", ko: "시험", zh: "测试" }, pinyins: ["test"] }], examples: [], topics: ["Education"], notes: "" }),
} });
await db.doc("config/vocabulary").set({ smartAddSchema: {}, smartAddPrompts: { default: "Generate word definitions" }, segmentPrompt: "", segmentSchema: {} });
const storage = await import("../../../src/firestore.js");
const app = Fastify();
await app.register(sensible);
await app.register((await import("../../../src/routes/vocab.js")).default, { prefix: "/api/vocab" });
await app.register((await import("../../../src/routes/quiz.js")).default, { prefix: "/api/quiz" });
await app.register((await import("../../../src/routes/combined-quiz.js")).default, { prefix: "/api/combined-quiz" });
const run = promisify(execFile);
const cleanup = async (mode: string) => {
  const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/remove-retired-word-data.ts", "--target=emulator", mode], { env: process.env });
  return stdout.trim().split("\n").map(line => JSON.parse(line));
};

test("all-language CRUD, legacy inputs, quiz answers and backed-up cleanup", async () => {
  try {
    for (const language of ["chinese", "english", "japanese", "korean"]) {
      await storage.createLanguage(language);
      const added = await app.inject({ method: "POST", url: `/api/vocab/${language}/smart-add`, payload: { term: `test-${language}`, flag: true, definitions: [{ partOfSpeech: "noun", text: { ja: "試験" } }] } });
      assert.equal(added.statusCode, 201, added.body);
      const word = added.json();
      assert.equal("partOfSpeech" in word.definitions[0], false);
      assert.equal("partOfSpeech" in (await db.doc(`words/${word.id}`).get()).data()!.definitions[0], false);
      const edit = await app.inject({ method: "PUT", url: `/api/vocab/${language}/${word.id}`, payload: { definitions: [{ partOfSpeech: "noun", text: { en: "edited" }, pinyins: ["reading"] }], grammaticalCategory: "noun", flag: true } });
      assert.equal(edit.statusCode, 200, edit.body);
      assert.deepEqual(edit.json().definitions, [{ text: { en: "edited" }, pinyins: ["reading"] }]);
      const list = await app.inject(`/api/vocab/${language}?category=nonexistent&flaggedOnly=true`);
      assert.equal(list.json().total, 1, list.body);
      const filters = await app.inject(`/api/vocab/${language}/filters`);
      assert.equal("categories" in filters.json(), false);
      const index = await app.inject(`/api/vocab/${language}/search-index`);
      assert.deepEqual(index.json().items[0].pos, []);
      const draft = await app.inject({ method: "POST", url: `/api/vocab/${language}/drafts`, payload: { drafts: [{ term: "draft", grammaticalCategory: "verb", definitions: [{ partOfSpeech: "verb", text: { en: "draft" } }] }] } });
      assert.equal(draft.statusCode, 201, draft.body);
      assert.equal("partOfSpeech" in draft.json().drafts[0].definitions[0], false);
      const savedDraft = (await db.collection("word_drafts").where("language", "==", language).get()).docs[0];
      assert.equal("partOfSpeech" in savedDraft.data().definitions[0], false);
      const editedDraft = await app.inject({ method: "PUT", url: `/api/vocab/${language}/drafts/${savedDraft.id}`, payload: { definitions: [{ partOfSpeech: "verb", text: { en: "draft edit" } }] } });
      assert.deepEqual(editedDraft.json().definitions, [{ text: { en: "draft edit" } }]);
      const quiz = await app.inject({ method: "POST", url: "/api/quiz/start", payload: { language, flaggedOnly: true, categories: ["nonexistent"] } });
      assert.equal(quiz.statusCode, 201, quiz.body);
      assert.equal(quiz.json().questions.length, 1);
      assert.equal("flaggedOnly" in quiz.json(), false);
      const answer = await app.inject({ method: "POST", url: "/api/quiz/answer", payload: { sessionId: quiz.json().sessionId, wordId: word.id, correct: true, flagWordIds: [word.id] } });
      assert.equal(answer.statusCode, 200, answer.body);
      const combined = await app.inject({ method: "POST", url: "/api/combined-quiz/start", payload: { language, domainWeights: { word: 1, grammar: 0 }, word: { flaggedOnly: true, categories: ["nonexistent"] } } });
      assert.equal(combined.statusCode, 201, combined.body);
      assert.equal(combined.json().questions.length, 1);
      const combinedAnswer = await app.inject({ method: "POST", url: "/api/combined-quiz/answer", payload: { language, kind: "word", refId: word.id, correct: false, flagWordIds: [word.id] } });
      assert.equal(combinedAnswer.statusCode, 200, combinedAnswer.body);
    }
    assert.equal((await db.collection("flagged_words").get()).size, 0);
    assert.equal((await app.inject("/api/flagged/chinese")).statusCode, 404);
    const definition = { partOfSpeech: "verb", text: { en: "return" }, pinyins: ["huán"] };
    await db.doc("words/legacy").set({ term: "还", language: "chinese", definitions: [definition], grammaticalCategory: "verb", topics: [] });
    await db.doc("word_drafts/legacy").set({ term: "还", definitions: [definition], flag: true });
    await db.doc("flagged_words/chinese_legacy").set({ language: "chinese", wordId: "legacy", flaggedAt: "past" });
    // Exercise deletion pagination beyond one 200-document batch.
    const flags = db.batch();
    for (let i = 0; i < 205; i++) flags.set(db.doc(`flagged_words/extra-${i}`), { wordId: `extra-${i}`, language: "chinese" });
    await flags.commit();
    const session = { flaggedOnly: true, status: "completed", score: { correct: 1, total: 2 }, reviewState: { cursor: 1 }, questions: [{ kind: "word", wordId: "legacy", definitions: [definition], userCorrect: false }, { kind: "grammar", grammarId: "g", descriptions: [definition] }] };
    await db.doc("combined_quiz_sessions/legacy__mixed").set(session);
    await db.doc("grammar_items/preserved").set({ descriptions: [definition] });
    const preview = await cleanup("--dry-run");
    assert.equal(preview.find(row => row.collection === "flagged_words").changed, 206);
    assert.equal((await db.doc("flagged_words/chinese_legacy").get()).exists, true);
    const applied = await cleanup("--apply");
    const backup = (await readFile(applied[0].backupPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(backup.find(row => row.path === "words/legacy").data.definitions, [definition]);
    assert.equal(backup[0].updateTime.$type, "timestamp");
    assert.equal(backup.filter(row => row.path.startsWith("flagged_words/")).length, 206);
    assert.equal((await db.collection("flagged_words").get()).size, 0);
    const cleanWord = (await db.doc("words/legacy").get()).data()!;
    assert.equal("grammaticalCategory" in cleanWord, false);
    assert.deepEqual(cleanWord.definitions, [{ text: { en: "return" }, pinyins: ["huán"] }]);
    const cleanSession = (await db.doc("combined_quiz_sessions/legacy__mixed").get()).data()!;
    assert.equal("flaggedOnly" in cleanSession, false);
    assert.deepEqual(cleanSession.score, session.score);
    assert.deepEqual(cleanSession.reviewState, session.reviewState);
    assert.deepEqual(cleanSession.questions[1], session.questions[1]);
    assert.deepEqual((await db.doc("grammar_items/preserved").get()).data()!.descriptions, [definition]);
    assert.ok((await cleanup("--dry-run")).filter(row => row.collection).every(row => row.changed === 0));
    await assert.rejects(run(process.execPath, ["--import", "tsx", "scripts/remove-retired-word-data.ts", "--target=production", "--apply"], { env: process.env }));
  } finally {
    await app.close();
    await db.terminate();
  }
});
