import "./math-evaluation-target.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { db } from "../src/firestore.js";
import { installLLMBudgets } from "../src/llm-budget.js";
import mathRoutes from "../src/routes/math.js";
import type { MathBook, MathPublicTest } from "../src/math-types.js";

// Explicit, paid live-model smoke test. Uses the current source routes, not HTTP
// authentication. All session and evidence documents are isolated and removed.
const target = process.argv[2];
if (!["--target=production", "--target=emulator"].includes(target))
  throw new Error("Usage: tsx scripts/smoke-math-continuous.ts --target=production|emulator");
if ((target === "--target=emulator") !== !!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Explicit target conflicts with emulator configuration");
const app = Fastify();
installLLMBudgets(app);
await app.register(mathRoutes, { prefix: "/api/math" });
const runId = `continuous-smoke-${randomUUID()}`;
const ref = db.collection("math_tests").doc(runId);
const evidence = db.collection("math_learning_evidence").doc(runId);
async function post(path: string, payload: unknown): Promise<MathPublicTest> {
  const response = await app.inject({ method: "POST", url: `/api/math${path}`, payload });
  assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
  return response.json();
}
let state: MathPublicTest;
try {
  const response = await app.inject("/api/math/books");
  const books = (response.json() as MathBook[]).filter(b => b.publicationId && b.chapters.length);
  assert.ok(books.length, "No published textbooks");
  const book = books.find(b => b.id === "linear-algebra") ?? books[0];
  const scopes = [{ bookId: book.id, chapterIds: [book.chapters[0].id] }];
  state = await post("/tests", {
    operationId: runId, scopes, assessmentVersion: 2,
    taskKinds: ["prove", "determine", "compute", "derive"], difficulty: "standard",
  });
  await ref.update({ evidenceNamespace: runId });
  const act = async (action: string, body: Record<string, unknown> = {}) => {
    state = await post(`/tests/${runId}/${action}`, {
      operationId: randomUUID(), version: state.version, ...body,
    });
  };
  await act("next");
  const current = state.currentQuestionId;
  assert.equal(state.questions[0].bookId, book.id);
  const reveal = { operationId: randomUUID(), version: state.version, questionId: current };
  state = await post(`/tests/${runId}/reveal`, reveal);
  const replay = await post(`/tests/${runId}/reveal`, reveal);
  assert.equal(replay.version, state.version);
  assert.equal(state.phase, "solution");
  assert.equal(state.stats?.revealed, 1);
  const nextChapter = book.chapters[1] ?? book.chapters[0];
  await act("scope", { scopes: [{ bookId: book.id, chapterIds: [nextChapter.id] }] });
  assert.equal(state.currentQuestionId, current);
  assert.equal(state.phase, "solution");
  assert.equal(state.scopeRevision, 1);
  await act("next");
  assert.notEqual(state.currentQuestionId, current);
  assert.equal(state.questions[0].chapterId, nextChapter.id);
  await act("reveal", { questionId: state.currentQuestionId });
  await act("state", { action: "pause" });
  await act("state", { action: "resume" });
  assert.equal(state.phase, "solution");
  assert.equal(state.stats?.answered, 0);
  assert.equal(state.stats?.revealed, 2);
  await act("state", { action: "finish" });
  assert.equal(state.status, "completed");
  console.log(JSON.stringify({ target, passed: true, booksAvailable: books.length,
    publication: book.publicationId, generated: state.generatedCount,
    revealed: state.stats?.revealed, answered: state.stats?.answered }));
} finally {
  await db.recursiveDelete(ref);
  await db.recursiveDelete(evidence);
  assert.equal((await ref.get()).exists, false);
  assert.equal((await evidence.get()).exists, false);
  console.log("Isolated session and evidence removed");
  await app.close();
  await db.terminate();
}
