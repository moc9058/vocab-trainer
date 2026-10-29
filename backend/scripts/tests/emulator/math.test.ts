import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { MathTest, MathSource } from "../../../src/math-types.js";
if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Math integration tests require the Firestore emulator");
let failGrade = false;
let failGenerate = false;
let forceDuplicate = false;
let blockedGeneration: (() => Promise<void>) | undefined;
mock.module("../../../src/math-llm.ts", {
  namedExports: {
    generateMathQuestions: async (test: MathTest, sources: MathSource[]) => {
      assert.deepEqual(
        sources.map((s) => s.id),
        ["c1", "c2"],
      );
      if (failGenerate) throw new Error("Mock generation failure");
      if (blockedGeneration) {
        const block = blockedGeneration;
        blockedGeneration = undefined;
        await block();
      }
      return [
        {
          id: "q1",
          chapterId: "c2",
          heading: "Subspaces",
          kind: "definition",
          prompt:
            test.mode === "continuous"
              ? `Define a subspace variant ${forceDuplicate ? 0 : (test.generatedCount ?? 0)}.`
              : "Define a subspace.",
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

  await test("continuous tests persist feedback, append idempotently, paginate and keep parent storage bounded", async () => {
    const id = `${prefix}-continuous`;
    const created = await post("/tests", {
      operationId: id,
      bookId,
      chapterIds: ["c2"],
      mode: "continuous",
      kinds: ["definition"],
      difficulty: "standard",
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.phase, "ready");
    assert.equal(created.data.count, 0);
    assert.equal(
      (
        await post("/tests", {
          operationId: randomUUID(),
          bookId,
          chapterIds: ["c2"],
          mode: "continuous",
          count: 5,
          kinds: ["definition"],
          difficulty: "standard",
        })
      ).status,
      400,
    );
    const firstOp = {
      operationId: randomUUID(),
      version: created.data.version,
    };
    failGenerate = true;
    assert.equal((await post(`/tests/${id}/next`, firstOp)).status, 503);
    failGenerate = false;
    let response = await post(`/tests/${id}/next`, firstOp);
    assert.equal(response.status, 200);
    let state = response.data;
    assert.equal(state.generatedCount, 1);
    assert.equal(state.phase, "question");
    assert.equal(state.questions[0].solution, undefined);
    assert.equal(
      (
        await post(`/tests/${id}/next`, {
          operationId: randomUUID(),
          version: state.version,
        })
      ).status,
      409,
    );
    const gradeOp = {
      operationId: randomUUID(),
      version: state.version,
      questionId: "q1",
      text: "first answer",
    };
    failGrade = true;
    assert.equal((await post(`/tests/${id}/answer`, gradeOp)).status, 503);
    failGrade = false;
    const saved = (await app.inject(`/api/math/tests/${id}`)).json();
    assert.equal(saved.answers.q1.text, "first answer");
    assert.equal(saved.questions[0].solution, undefined);
    response = await post(`/tests/${id}/answer`, gradeOp);
    state = response.data;
    assert.equal(response.status, 200);
    assert.equal(state.status, "active");
    assert.equal(state.phase, "feedback");
    assert.equal(state.stats.answered, 1);
    assert.ok(state.questions[0].solution);
    assert.equal(
      (await post(`/tests/${id}/answer`, gradeOp)).data.stats.answered,
      1,
    );
    let reloaded = (await app.inject(`/api/math/tests/${id}`)).json();
    assert.equal(reloaded.phase, "feedback");
    assert.equal(reloaded.currentQuestionId, "q1");
    const pause = await post(`/tests/${id}/state`, {
      operationId: randomUUID(),
      version: state.version,
      action: "pause",
    });
    response = await post(`/tests/${id}/state`, {
      operationId: randomUUID(),
      version: pause.data.version,
      action: "resume",
    });
    state = response.data;
    assert.equal(state.phase, "feedback");
    forceDuplicate = true;
    assert.equal(
      (
        await post(`/tests/${id}/next`, {
          operationId: randomUUID(),
          version: state.version,
        })
      ).status,
      409,
    );
    forceDuplicate = false;
    state = (await app.inject(`/api/math/tests/${id}`)).json();
    assert.equal(state.generatedCount, 1);
    assert.equal(state.phase, "feedback");
    const nextOp = { operationId: randomUUID(), version: state.version };
    response = await post(`/tests/${id}/next`, nextOp);
    state = response.data;
    assert.equal(response.status, 200);
    assert.equal(state.currentQuestionId, "q2");
    assert.equal(
      (await post(`/tests/${id}/next`, nextOp)).data.generatedCount,
      2,
    );
    const early = (await app.inject(`/api/math/tests/${id}/questions`)).json();
    assert.equal(early.items[1].question.solution, undefined);
    assert.ok(early.items[0].question.solution);
    // More than a page of large answers must not enlarge the parent document.
    while (state.generatedCount <= 21) {
      const q = state.questions[0];
      response = await post(`/tests/${id}/answer`, {
        operationId: randomUUID(),
        version: state.version,
        questionId: q.id,
        text: "reasoning ".repeat(400),
      });
      assert.equal(response.status, 200);
      state = response.data;
      if (state.generatedCount === 21) break;
      response = await post(`/tests/${id}/next`, {
        operationId: randomUUID(),
        version: state.version,
      });
      assert.equal(response.status, 200);
      state = response.data;
    }
    assert.equal(state.stats.answered, 21);
    assert.equal(state.status, "active");
    const parent = (await db.collection("math_tests").doc(id).get()).data()!;
    assert.deepEqual(parent.questions, []);
    assert.deepEqual(parent.answers, {});
    assert.ok(Buffer.byteLength(JSON.stringify(parent)) < 6000);
    assert.equal(
      (await db.collection("math_tests").doc(id).collection("questions").get())
        .size,
      21,
    );
    const page1 = (await app.inject(`/api/math/tests/${id}/questions`)).json();
    assert.equal(page1.items.length, 20);
    assert.equal(page1.nextCursor, 20);
    const page2 = (
      await app.inject(`/api/math/tests/${id}/questions?after=20`)
    ).json();
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].number, 21);
    assert.equal(page2.nextCursor, null);
    const next = await post(`/tests/${id}/next`, {
      operationId: randomUUID(),
      version: state.version,
    });
    state = next.data;
    const paused = await post(`/tests/${id}/state`, {
      operationId: randomUUID(),
      version: state.version,
      action: "pause",
      draft: "unfinished proof",
    });
    const done = await post(`/tests/${id}/state`, {
      operationId: randomUUID(),
      version: paused.data.version,
      action: "finish",
      draft: "unfinished proof",
    });
    assert.equal(done.status, 200);
    assert.equal(done.data.status, "completed");
    assert.equal(done.data.generatedCount, 22);
    assert.equal(done.data.answers.q22.submitted, false);
    const lastPage = (
      await app.inject(`/api/math/tests/${id}/questions?after=21`)
    ).json();
    assert.ok(lastPage.items[0].question.solution);
    assert.equal(lastPage.items[0].answer.text, "unfinished proof");
    assert.equal(
      (
        await post(`/tests/${id}/next`, {
          operationId: randomUUID(),
          version: done.data.version,
        })
      ).status,
      409,
    );
  });

  await test("legacy multi-question tests pause at feedback and advance without generating", async () => {
    const id = `${prefix}-legacy`;
    const created = await post("/tests", {
      operationId: id,
      bookId,
      chapterIds: ["c2"],
      count: 2,
      kinds: ["definition"],
      difficulty: "standard",
    });
    assert.equal(created.status, 200);
    const q = {
      id: "q1",
      chapterId: "c2",
      heading: "Subspaces",
      kind: "definition",
      prompt: "First?",
      solution: "A",
      rubric: "A",
    };
    await db
      .collection("math_tests")
      .doc(id)
      .update({
        status: "active",
        questions: [q, { ...q, id: "q2", prompt: "Second?" }],
      });
    let response = await post(`/tests/${id}/answer`, {
      operationId: randomUUID(),
      version: 0,
      questionId: "q1",
      text: "A",
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.phase, "feedback");
    assert.equal(response.data.status, "active");
    assert.equal(response.data.questions[1].solution, undefined);
    response = await post(`/tests/${id}/next`, {
      operationId: randomUUID(),
      version: response.data.version,
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.currentQuestionId, "q2");
    assert.equal(response.data.phase, "question");
    response = await post(`/tests/${id}/answer`, {
      operationId: randomUUID(),
      version: response.data.version,
      questionId: "q2",
      text: "A",
    });
    assert.equal(response.data.status, "completed");
    const history = (
      await app.inject(`/api/math/tests/${id}/questions`)
    ).json();
    assert.equal(history.items.length, 2);
    assert.ok(history.items[1].question.solution);
  });
  await test("expired generation cannot overwrite a newer question or its prompt marker", async () => {
    const id = `${prefix}-lease`;
    const created = await post("/tests", {
      operationId: id,
      bookId,
      chapterIds: ["c2"],
      mode: "continuous",
      kinds: ["definition"],
      difficulty: "standard",
    });
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    blockedGeneration = async () => {
      started();
      await held;
    };
    const stale = post(`/tests/${id}/next`, {
      operationId: randomUUID(),
      version: created.data.version,
    });
    await began;
    try {
      await db.collection("math_tests").doc(id).update({ "lock.until": 0 });
      const snapshot = (await app.inject(`/api/math/tests/${id}`)).json();
      const fresh = await post(`/tests/${id}/next`, {
        operationId: randomUUID(),
        version: snapshot.version,
      });
      assert.equal(fresh.status, 200);
      release();
      assert.equal((await stale).status, 409);
      const saved = (await app.inject(`/api/math/tests/${id}`)).json();
      assert.equal(saved.version, fresh.data.version);
      assert.equal(saved.generatedCount, 1);
      assert.equal(saved.phase, "question");
      assert.equal(
        (
          await db
            .collection("math_tests")
            .doc(id)
            .collection("questions")
            .get()
        ).size,
        1,
      );
      assert.equal(
        (await db.collection("math_tests").doc(id).collection("prompts").get())
          .size,
        1,
      );
    } finally {
      release();
      await stale;
    }
  });
} finally {
  for (const id of [
    testId,
    `${prefix}-concurrent`,
    `${prefix}-continuous`,
    `${prefix}-legacy`,
    `${prefix}-lease`,
  ])
    await db.recursiveDelete(db.collection("math_tests").doc(id));
  await db.collection("math_books").doc(bookId).delete();
  for (const c of chapters)
    await db.collection("math_chapter_versions").doc(c.versionId).delete();
  await app.close();
  await db.terminate();
}
