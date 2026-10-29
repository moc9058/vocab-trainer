import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { MathTest, MathSource } from "../../../src/math-types.js";
if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Math integration tests require the Firestore emulator");
let failGrade = false;
let failGenerate = false;
mock.module("../../../src/math-llm.ts", {
  namedExports: {
    generateMathQuestions: async (test: MathTest, sources: MathSource[]) => {
      assert.deepEqual(
        sources.map((s) => s.id),
        ["c1", "c2"],
      );
      if (failGenerate) throw new Error("Mock generation failure");
      return [
        {
          id: "q1",
          chapterId: "c2",
          heading: "Subspaces",
          kind: "definition",
          prompt: "Define a subspace.",
          solution: "Zero and closure.",
          rubric: "Check both operations.",
        },
      ];
    },
    gradeMathAnswer: async () => {
      if (failGrade) throw new Error("Mock grading failure");
      return { verdict: "partial", feedback: "Include zero." };
    },
  },
});
const { default: mathRoutes } = await import("../../../src/routes/math.js");
const { db } = await import("../../../src/firestore.js");
const app = Fastify();
await app.register(mathRoutes, { prefix: "/api/math" });
const prefix = `math-test-${randomUUID()}`;
const bookId = prefix;
const testId = `${prefix}-session`;
const chapters = [1, 2].map((n) => ({
  id: `c${n}`,
  title: `Chapter ${n}`,
  number: n,
  versionId: `${prefix}-v${n}`,
}));
const book = {
  id: bookId,
  subjectId: "linear",
  subjectTitle: "Linear",
  title: "Linear",
  language: "en",
  revision: "r1",
  chapters,
};
const post = async (path: string, body: unknown) => {
  const response = await app.inject({
    method: "POST",
    url: `/api/math${path}`,
    payload: body,
  });
  return { status: response.statusCode, data: response.json() };
};
try {
  await db.collection("math_books").doc(bookId).set(book);
  for (const chapter of chapters)
    await db
      .collection("math_chapter_versions")
      .doc(chapter.versionId)
      .set({ ...chapter, bookId, markdown: "# Subspaces\nDefinition" });
  await test("math lifecycle: immutable scope, failed work, replay, conflict, grading privacy and resume", async () => {
    const create = {
      operationId: testId,
      bookId,
      chapterIds: ["c2"],
      count: 1,
      kinds: ["definition"],
      difficulty: "standard",
    };
    let response = await post("/tests", create);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.data.sourceVersionIds,
      chapters.map((c) => c.versionId),
    );
    const original = response.data;
    assert.equal((await post("/tests", { ...create, count: 2 })).status, 409);
    assert.equal(
      (
        await post("/tests", {
          ...create,
          operationId: randomUUID(),
          chapterIds: ["missing"],
        })
      ).status,
      400,
    );
    // Publication changes never affect a running test's stored book/sources.
    await db
      .collection("math_books")
      .doc(bookId)
      .update({ revision: "r2", title: "Changed book" });
    const generation = { operationId: randomUUID(), version: original.version };
    failGenerate = true;
    response = await post(`/tests/${testId}/generate`, generation);
    assert.equal(response.status, 503);
    const failed = (await app.inject(`/api/math/tests/${testId}`)).json();
    assert.equal(failed.status, "generation_failed");
    failGenerate = false;
    response = await post(`/tests/${testId}/generate`, generation);
    assert.equal(response.status, 200);
    let active = response.data;
    assert.equal(active.book.revision, "r1");
    assert.equal(active.questions[0].solution, undefined);
    assert.equal(active.requestHash, undefined);
    const replay = await post(`/tests/${testId}/generate`, generation);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.version, active.version);
    const pause = {
      operationId: randomUUID(),
      version: active.version,
      action: "pause",
      draft: "A vector subset",
    };
    response = await post(`/tests/${testId}/state`, pause);
    assert.equal(response.status, 200);
    assert.equal(response.data.status, "paused");
    assert.equal(response.data.draft, pause.draft);
    assert.equal(
      (
        await post(`/tests/${testId}/state`, {
          ...pause,
          operationId: randomUUID(),
        })
      ).status,
      409,
    );
    response = await post(`/tests/${testId}/state`, {
      operationId: randomUUID(),
      version: response.data.version,
      action: "resume",
      draft: pause.draft,
    });
    assert.equal(response.status, 200);
    active = response.data;
    const answer = {
      operationId: randomUUID(),
      version: active.version,
      questionId: "q1",
      text: "Closed under addition and multiplication",
    };
    failGrade = true;
    response = await post(`/tests/${testId}/answer`, answer);
    assert.equal(response.status, 503);
    const ungraded = (await app.inject(`/api/math/tests/${testId}`)).json();
    assert.equal(ungraded.status, "active");
    assert.equal(ungraded.answers.q1.text, answer.text);
    assert.equal(ungraded.questions[0].solution, undefined);
    assert.equal(ungraded.draft, answer.text);
    failGrade = false;
    response = await post(`/tests/${testId}/answer`, answer);
    assert.equal(response.status, 200);
    assert.equal(response.data.status, "completed");
    assert.equal(response.data.answers.q1.grade.verdict, "partial");
    assert.equal(response.data.questions[0].solution, "Zero and closure.");
    const gradeReplay = await post(`/tests/${testId}/answer`, answer);
    assert.equal(gradeReplay.status, 200);
    assert.equal(gradeReplay.data.version, response.data.version);
    assert.equal(
      (await post(`/tests/${testId}/answer`, { ...answer, text: "changed" }))
        .status,
      409,
    );
    assert.equal(
      (
        await post(`/tests/${testId}/state`, {
          operationId: randomUUID(),
          version: response.data.version,
          action: "resume",
        })
      ).status,
      409,
    );
    assert.equal((await post("/tests", create)).status, 200);
  });
  await test("concurrent mutations allow one writer and finishing exposes unanswered solutions", async () => {
    const id = `${prefix}-concurrent`;
    const request = {
      operationId: id,
      bookId,
      chapterIds: ["c2"],
      count: 1,
      kinds: ["definition"],
      difficulty: "standard",
    };
    await post("/tests", request);
    const generated = await post(`/tests/${id}/generate`, {
      operationId: randomUUID(),
      version: 0,
    });
    const make = () =>
      post(`/tests/${id}/state`, {
        operationId: randomUUID(),
        version: generated.data.version,
        action: "pause",
        draft: "draft",
      });
    const results = await Promise.all([make(), make()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const paused = results.find((r) => r.status === 200)!.data;
    const done = await post(`/tests/${id}/state`, {
      operationId: randomUUID(),
      version: paused.version,
      action: "finish",
    });
    assert.equal(done.data.status, "completed");
    assert.ok(done.data.questions[0].solution);
  });
} finally {
  for (const id of [testId, `${prefix}-concurrent`])
    await db.recursiveDelete(db.collection("math_tests").doc(id));
  await db.collection("math_books").doc(bookId).delete();
  for (const c of chapters)
    await db.collection("math_chapter_versions").doc(c.versionId).delete();
  await app.close();
  await db.terminate();
}
