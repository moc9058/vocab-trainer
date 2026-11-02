import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Firestore } from "@google-cloud/firestore";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("An explicit emulator is required");
process.env.FIRESTORE_PROJECT = `grammar-ko-test-${Date.now()}`;
process.env.FIRESTORE_DATABASE_ID = "vocab-database";
const db = new Firestore({ projectId: process.env.FIRESTORE_PROJECT, databaseId: "vocab-database" });
const actualLLM = await import("../../../src/llm.js");
let incomplete = false;
let prompt = "";
mock.module("../../../src/llm.js", { namedExports: {
  ...actualLLM,
  callLLM: async ({ system, user }: { system: string; user: string }) => {
    prompt = system;
    return JSON.stringify({ descriptions: JSON.parse(user).descriptions.map(() => ({
      partOfSpeech: "model must not override this",
      text: { ja: "生成された日本語", ...(incomplete ? {} : { ko: "생성된 한국어" }) },
    })) });
  },
} });
await db.doc("config/grammar").set({ smartAddSchema: {}, smartAddPrompts: { default: "Complete {{DEFINITION_LANGUAGES}}" } });
const app = Fastify();
await app.register(sensible);
await app.register((await import("../../../src/routes/grammar.js")).default, { prefix: "/api/grammar" });
const root = "/api/grammar/chinese";
const post = (id: string, text: Record<string, string>) => app.inject({ method: "POST", url: `${root}/smart-add`, payload: {
  id, statement: "把+O+V", transliteration: "ba+O+V", descriptions: [{ partOfSpeech: "construction", text, pinyins: ["bǎ"] }],
} });

test("Korean-only and Japanese-only descriptions survive create, read, edit and draft registration", async () => {
  try {
    const anchors = [{ ko: "  입력한 한국어  " }, { ja: "入力した日本語" }, { ko: "한국어", ja: "日本語", en: "Other authored language" }];
    for (let i = 0; i < anchors.length; i++) {
      const response = await post(`ko-${i}`, anchors[i]);
      assert.equal(response.statusCode, 201, response.body);
      assert.match(prompt, /"ja"/);
      assert.match(prompt, /"ko"/);
      const expected = { ja: "生成された日本語", ko: "생성된 한국어", ...anchors[i] };
      assert.deepEqual(response.json().descriptions[0], { partOfSpeech: "construction", text: expected, pinyins: ["bǎ"] });
      assert.deepEqual((await db.doc(`grammar_items/ko-${i}`).get()).data()!.descriptions[0].text, expected);
      const read = await app.inject({ method: "POST", url: `${root}/items/batch`, payload: { ids: [`ko-${i}`] } });
      assert.deepEqual(read.json().items[0].descriptions[0].text, expected);
    }
    const manual = await app.inject({ method: "POST", url: `${root}/items`, payload: {
      id: "manual", statement: "S+V", transliteration: "S+V", descriptions: [{ partOfSpeech: "", text: { ko: "직접 등록" } }],
    } });
    assert.equal(manual.statusCode, 201, manual.body);
    const edit = await app.inject({ method: "PUT", url: `${root}/items/manual`, payload: {
      descriptions: [{ partOfSpeech: "", text: { ja: "説明", ko: "수정한 설명" } }],
    } });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(edit.json().descriptions[0].text.ko, "수정한 설명");
    const draft = await app.inject({ method: "POST", url: `${root}/drafts`, payload: { drafts: [{
      statement: "把+O+V", descriptions: [{ partOfSpeech: "", text: { ko: "초안의 설명" } }],
    }] } });
    assert.equal(draft.statusCode, 201, draft.body);
    const draftId = draft.json().drafts[0].id;
    assert.equal((await db.doc(`grammar_drafts/${draftId}`).get()).data()!.descriptions[0].text.ko, "초안의 설명");
    const registered = await post("promoted", draft.json().drafts[0].descriptions[0].text);
    assert.equal(registered.statusCode, 201, registered.body);
    assert.equal(registered.json().descriptions[0].text.ko, "초안의 설명");
    incomplete = true;
    const failed = await post("incomplete", { ja: "説明" });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal((await db.doc("grammar_items/incomplete").get()).exists, false);
    assert.equal((await db.collection("example_sentences").get()).empty, true);
  } finally {
    await app.close();
    await db.terminate();
  }
});
