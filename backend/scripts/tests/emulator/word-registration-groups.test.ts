import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Firestore } from "@google-cloud/firestore";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("An explicit emulator is required");
process.env.FIRESTORE_PROJECT = `word-group-test-${Date.now()}`;
process.env.FIRESTORE_DATABASE_ID = "vocab-database";
const db = new Firestore({ projectId: process.env.FIRESTORE_PROJECT, databaseId: "vocab-database" });
const actualLLM = await import("../../../src/llm.js");
let llmCalls = 0;
let duringGeneration: (() => Promise<void>) | undefined;
mock.module("../../../src/llm.js", { namedExports: {
  ...actualLLM,
  callLLM: async () => {
    llmCalls++;
    await duringGeneration?.();
    return JSON.stringify({ transliteration: "test", definitions: [{ text: { en: "test", ko: "테스트" } }], examples: [], topics: ["Education"], notes: "" });
  },
} });
await db.doc("config/vocabulary").set({ smartAddSchema: {}, smartAddPrompts: { default: "Generate word definitions" }, segmentPrompt: "", segmentSchema: {} });
const storage = await import("../../../src/firestore.js");
const app = Fastify();
await app.register(sensible);
await app.register((await import("../../../src/routes/vocab.js")).default, { prefix: "/api/vocab" });
const seed = async (id: string, createdAt: string, category?: "A" | "B", language = "chinese", order = 0) => {
  await db.doc(`word_groups/${id}`).set({ id, language, name: id, wordIds: [], createdAt, order, ...(category ? { category } : {}) });
};
const create = (term: string, groups: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/vocab/chinese/smart-add", payload: { term, ...groups } });
const members = async (id: string) => (await db.doc(`word_groups/${id}`).get()).data()!.wordIds as string[];

test("registration chooses a required A home and atomically attaches requested B groups", async () => {
  try {
    await storage.createLanguage("chinese");
    const missing = await create("missing-A");
    assert.equal(missing.statusCode, 400, missing.body);
    assert.equal(llmCalls, 0);
    await seed("old-a", "2026-10-01", undefined, "chinese", 0);
    await seed("new-a", "2026-11-01", "A", "chinese", 9);
    await seed("b1", "2026-11-02", "B");
    await seed("b2", "2026-11-02", "B");
    await seed("foreign", "2026-12-01", "A", "japanese");
    for (const groups of [{ groupIds: ["missing"] }, { groupIds: ["foreign"] }, { groupIds: ["old-a", "new-a"] }, { groupBIds: ["old-a"] }]) {
      const before = llmCalls;
      const invalid = await create("invalid", groups);
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal(llmCalls, before);
    }
    const automatic = await create("automatic");
    assert.equal(automatic.statusCode, 201, automatic.body);
    assert.ok((await members("new-a")).includes(automatic.json().id));
    assert.equal((await members("old-a")).length, 0);
    const explicit = await create("explicit", { groupIds: ["old-a", "b1"], groupBIds: ["b1", "b2"] });
    assert.equal(explicit.statusCode, 201, explicit.body);
    const id = explicit.json().id;
    assert.ok((await members("old-a")).includes(id));
    assert.equal((await members("new-a")).includes(id), false);
    assert.equal((await members("b1")).filter(item => item === id).length, 1);
    assert.ok((await members("b2")).includes(id));
    const stored = (await db.doc(`words/${id}`).get()).data()!;
    assert.equal(typeof stored.addedToGroupAAt, "string");
    assert.equal(typeof stored.addedToGroupBAt, "string");
    assert.equal("groupIds" in stored, false);
    assert.equal("groupBIds" in stored, false);
    const clock = stored.addedToGroupBAt;
    await storage.modifyWordGroupMembers("b1", [id], "add");
    assert.equal((await db.doc(`words/${id}`).get()).data()!.addedToGroupBAt, clock);
    const onlyB = await create("only-b", { groupBIds: ["b1"] });
    assert.equal(onlyB.statusCode, 201, onlyB.body);
    assert.ok((await members("new-a")).includes(onlyB.json().id));
    assert.ok((await members("b1")).includes(onlyB.json().id));
    // Default is resolved again at commit, not frozen before a long generation.
    duringGeneration = () => seed("newest-a", "2026-12-01", "A", "chinese", 99);
    const changedDefault = await create("new-default");
    assert.equal(changedDefault.statusCode, 201, changedDefault.body);
    assert.ok((await members("newest-a")).includes(changedDefault.json().id));
    // Deleting an explicit target during generation cannot leave a word/index behind.
    duringGeneration = async () => { await db.doc("word_groups/b2").delete(); };
    const beforeWords = (await db.collection("words").get()).size;
    const deleted = await create("deleted-group", { groupBIds: ["b2"] });
    assert.equal(deleted.statusCode, 400, deleted.body);
    assert.equal((await db.collection("words").get()).size, beforeWords);
    assert.equal(await storage.lookupWordByTerm("chinese", "deleted-group"), null);
    duringGeneration = undefined;
    // Concurrent creation of one term commits exactly one word and A/B membership.
    const duplicates = await Promise.all([create("same-term", { groupBIds: ["b1"] }), create("same-term", { groupBIds: ["b1"] })]);
    assert.deepEqual(duplicates.map(response => response.statusCode).sort(), [201, 409]);
    const same = await db.collection("words").where("term", "==", "same-term").get();
    assert.equal(same.size, 1);
    assert.ok((await members("newest-a")).includes(same.docs[0].id));
    assert.ok((await members("b1")).includes(same.docs[0].id));
  } finally {
    await app.close();
    await db.terminate();
  }
});
