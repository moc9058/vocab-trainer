// Executes the production transaction callback against an atomic in-memory Firestore adapter.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { CombinedQuizSession } from "../../src/types.js";
import { reconcileMixedScope } from "../../src/mixed-quiz-scope.js";

const documents = new Map<string, any>();
let failCommit = false;
class Ref {
  constructor(public path: string) {}
  get id() { return this.path.split("/").at(-1)!; }
  collection(name: string) { return new Collection(`${this.path}/${name}`); }
  async get() { return snap(this); }
}
class Collection {
  constructor(public path: string, public language?: string) {}
  doc(id: string) { return new Ref(`${this.path}/${id}`); }
  where(_field: string, _operator: string, language: string) { return new Collection(this.path, language); }
}
function snap(ref: Ref) {
  return { id: ref.id, ref, exists: documents.has(ref.path), data: () => structuredClone(documents.get(ref.path)) };
}
class Firestore {
  collection(name: string) { return new Collection(name); }
  async runTransaction<T>(fn: (tx: any) => Promise<T>) {
    const writes: (() => void)[] = [];
    const assertRead = () => assert.equal(writes.length, 0, "Firestore reads must precede writes");
    const result = await fn({
      get: async (ref: Ref | Collection) => {
        assertRead();
        if (ref instanceof Ref) return snap(ref);
        return { docs: [...documents.entries()].filter(([key, data]) => key.startsWith(`${ref.path}/`) && key.split("/").length === ref.path.split("/").length + 1 && data.language === ref.language).map(([key]) => snap(new Ref(key))) };
      },
      getAll: async (...refs: Ref[]) => { assertRead(); return refs.map(snap); },
      set: (ref: Ref, data: any) => writes.push(() => documents.set(ref.path, structuredClone(data))),
      update: (ref: Ref, data: any) => writes.push(() => {
        const value = structuredClone(documents.get(ref.path));
        for (const [key, op] of Object.entries(data) as [string, { remove: string }][]) value[key] = value[key].filter((id: string) => id !== op.remove);
        documents.set(ref.path, value);
      }),
    });
    if (failCommit) { failCommit = false; throw new Error("connection lost before commit"); }
    for (const write of writes) write();
    return result;
  }
}
mock.module("@google-cloud/firestore", { namedExports: { Firestore, FieldValue: { arrayRemove: (remove: string) => ({ remove }) }, FieldPath: {} } });
const { commitMixedQuizOperation, getCombinedQuizSession } = await import("../../src/firestore.js");
const key = "chinese__mixed";
const root = `combined_quiz_sessions/${key}`;
function seed(kind: "word" | "grammar" = "word") {
  documents.clear();
  const session: CombinedQuizSession = {
    sessionId: key, language: "chinese", startedAt: "start", status: "in-progress", initialTotal: 1,
    questions: [kind === "word" ? { kind, wordId: "x", term: "x", definitions: [] } : { kind, grammarId: "x", statement: "x" }],
    score: { correct: 0, total: 1 }, domainWeights: { word: 1, grammar: 1 }, reviewedQuestionCount: 0,
    wordGroupMembership: kind === "word" ? { b: ["x"] } : {}, grammarGroupMembership: kind === "grammar" ? { b: ["x"] } : {},
    mixedScope: { version: 1, wordA: {}, grammarA: {} },
    mixWeights: { category: { A: 1, B: 1 }, domain: { A: { word: 1, grammar: 1 }, B: { word: 1, grammar: 1 } } },
  };
  documents.set(root, session);
  const collection = kind === "word" ? "word_groups" : "grammar_groups";
  const field = kind === "word" ? "wordIds" : "grammarIds";
  for (const id of ["b", "b2", "outside"]) documents.set(`${collection}/${id}`, { id, createdAt: '2026-01-01', language: "chinese", category: id === "outside" ? "A" : "B", [field]: ["x"] });
}

test("word removal and Wrong commit atomically, survive resume, and replay once after lost response", async () => {
  seed();
  const op = { kind: "word" as const, refId: "x", correct: false, removeFromGroupB: true, startedAt: "start", operationId: "op-1" };
  failCommit = true;
  await assert.rejects(commitMixedQuizOperation(key, op), /connection lost/);
  assert.deepEqual(documents.get("word_groups/b").wordIds, ["x"]);
  assert.equal(documents.get(root).questions.length, 1);
  assert.equal(documents.has("progress/chinese_x"), false);
  const first = await commitMixedQuizOperation(key, op);
  const replay = await commitMixedQuizOperation(key, op);
  assert.deepEqual(replay.questions.map(q => [q.kind, q.userCorrect]), first.questions.map(q => [q.kind, q.userCorrect]));
  assert.deepEqual(replay.score, first.score);
  assert.deepEqual(documents.get("word_groups/b").wordIds, []);
  assert.deepEqual(documents.get("word_groups/b2").wordIds, []);
  assert.deepEqual(documents.get("word_groups/outside").wordIds, ["x"]);
  assert.equal(documents.get("progress/chinese_x").timesSeen, 1);
  assert.equal(first.questions.length, 2);
  assert.deepEqual(first.mixedScope?.retainedWordA, { outside: ["x"] });
  const read = await getCombinedQuizSession(key);
  assert.deepEqual(read?.mixedScope?.retainedWordA, { outside: ["x"] });
  reconcileMixedScope(read!, [...documents.entries()].filter(([k]) => k.startsWith("word_groups/")).map(([, v]) => v), [], [{ id: "x", term: "x", definitions: [] }] as any, []);
  assert.equal(read!.questions.filter(q => q.userCorrect === undefined).length, 1);
  await assert.rejects(commitMixedQuizOperation(key, { ...op, correct: true }), /reused/);
  await assert.rejects(commitMixedQuizOperation(key, { ...op, startedAt: "replaced", operationId: "old" }), /replaced/);
});

test("last grammar removal + Correct completes, and a replay cannot increment progress", async () => {
  seed("grammar");
  const op = { kind: "grammar" as const, refId: "x", correct: true, removeFromGroupB: true, startedAt: "start", operationId: "g-1" };
  const first = await commitMixedQuizOperation(key, op);
  assert.equal(first.status, "completed");
  await commitMixedQuizOperation(key, op);
  assert.equal(documents.get("grammar_progress/chinese_x").timesCorrect, 1);
  assert.deepEqual(documents.get("grammar_groups/b2").grammarIds, []);
  assert.equal(documents.get(root).score.correct, 1);
});

test("end-sitting removal commits without grading, and next answer uses retained A", async () => {
  seed();
  const removal = { kind: "word" as const, refId: "x", removeFromGroupB: true, startedAt: "start", operationId: "remove" };
  const first = await commitMixedQuizOperation(key, removal);
  assert.equal(first.score.correct, 0); assert.equal(first.questions.length, 1);
  assert.equal(documents.has("progress/chinese_x"), false);
  const last = await commitMixedQuizOperation(key, { ...removal, removeFromGroupB: false, correct: true, operationId: "answer" });
  assert.equal(last.status, "completed");
});
