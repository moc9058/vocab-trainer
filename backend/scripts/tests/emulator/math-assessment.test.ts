import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { mathHash } from "../../../src/math-core.js";
import { canonical, curriculumRevision } from "../../../src/math-curriculum.js";
import type {
  Curriculum,
  MathBook,
  MathTest,
  MathSource,
} from "../../../src/math-types.js";
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Emulator required");
let failGeneration = false;
mock.module("../../../src/llm.ts", {
  namedExports: { resolveModel: async () => "mock-model" },
});
mock.module("../../../src/math-llm.ts", {
  namedExports: {
    generateMathQuestions: async (t: MathTest) => {
      assert.ok(t.pendingPlans?.length);
      if (failGeneration) throw new Error("fixture generation failed");
      const p = t.pendingPlans![0];
      return [
        {
          schemaVersion: 2,
          id: "q1",
          chapterId: p.chapterId,
          primaryObjectiveId: p.primaryObjectiveId,
          taskKind: p.taskKind,
          prompt: `Find the value of position at t=${t.generatedCount ?? 0} seconds.`,
          solution: "0",
          rubric: "private",
          rubricItems: [{ id: "r", criterion: "private", weight: 1 }],
          kind: "calculation",
          heading: "1.1 Motion",
          publicationId: t.publicationId,
          curriculumRevision: t.curriculumRevision,
          assistanceStatus: "notReported",
        },
      ];
    },
    gradeMathAnswer: async () => ({
      verdict: "partial",
      score: 0.5,
      feedback: "Include units.",
    }),
  },
});
const { db } = await import("../../../src/firestore.js");
const { publishMathBook, loadMathCurriculum } = await import(
  "../../../src/math-publication.js"
);
const { default: routes } = await import("../../../src/routes/math.js");
const app = Fastify();
await app.register(routes, { prefix: "/api/math" });
const bookId = `assessment-${randomUUID()}`;
const source: MathSource = {
  id: "c1",
  number: 1,
  title: "Motion",
  versionId: `${bookId}-v1`,
  bookId,
  markdown: "# 1.1 Motion\nx=0 for an object at rest at the origin.",
};
const objective = {
  id: "position",
  chapterId: "c1",
  statement: "Compute position.",
  ability: "application" as const,
  supportedTaskKinds: ["compute" as const],
  sourceRefs: [{ chapterId: "c1", section: "1.1", heading: "1.1 Motion" }],
  prerequisiteObjectiveIds: [],
  requiredBackground: [],
  successCriteria: [{ id: "r", criterion: "Evaluate x." }],
  scopeConstraints: [],
  commonErrors: [],
  status: "active" as const,
};
const curriculum: Curriculum = {
  schemaVersion: 2,
  bookId,
  revision: "",
  sourceLanguage: "en",
  instructionLanguage: "en",
  sources: [
    {
      chapterId: "c1",
      file: "Physics/md/1. Motion.md",
      sha256: mathHash(source.markdown),
    },
  ],
  objectives: [objective],
};
curriculum.revision = curriculumRevision(curriculum);
const book: MathBook = {
  id: bookId,
  subjectId: "physics",
  subjectTitle: "Physics",
  title: "Physics fixture",
  language: "en",
  chapters: [
    {
      id: source.id,
      number: 1,
      title: source.title,
      versionId: source.versionId,
    },
  ],
  curriculumRevision: curriculum.revision,
  subjectProfile: {
    version: "physics-v1",
    subject: "physics",
    constraints: ["SI units"],
  },
  revision: "",
  publicationId: "",
};
book.revision = mathHash(canonical(book));
book.publicationId = book.revision;
const ids: string[] = [];
const extraPublications: string[] = [];
const post = async (path: string, payload: unknown) => {
  const r = await app.inject({
    method: "POST",
    url: `/api/math${path}`,
    payload,
  });
  return { status: r.statusCode, data: r.json() };
};
try {
  await test("publication dry-run writes nothing; immutable publication retries and missing references fail closed", async () => {
    await publishMathBook(db, book, [source], curriculum, true);
    assert.equal(
      (await db.collection("math_books").doc(bookId).get()).exists,
      false,
    );
    await publishMathBook(db, book, [source], curriculum, false);
    await publishMathBook(db, book, [source], curriculum, false);
    assert.equal((await loadMathCurriculum(db, book)).objectives.length, 1);
    await assert.rejects(
      () =>
        publishMathBook(
          db,
          book,
          [{ ...source, markdown: "mutated" }],
          curriculum,
          false,
        ),
      /Immutable document conflict/,
    );
    await db
      .collection("math_curriculum_versions")
      .doc(curriculum.revision)
      .collection("objectives")
      .doc("position")
      .delete();
    await assert.rejects(
      () => loadMathCurriculum(db, book),
      /MATH_CURRICULUM_MISSING/,
    );
    await publishMathBook(db, book, [source], curriculum, false);
  });
  await test("v2 plan retry, evidence receipts, assistance, skip and frozen publication survive updates", async () => {
    const id = `${bookId}-test`;
    ids.push(id);
    const creation = {
      operationId: id,
      bookId,
      chapterIds: ["c1"],
      assessmentVersion: 2,
      taskKinds: ["compute"],
      mode: "continuous",
      difficulty: "standard",
    };
    let r = await post("/tests", creation);
    assert.equal(r.status, 200);
    assert.equal(r.data.assessmentVersion, 2);
    assert.equal(r.data.publicationId, book.publicationId);
    assert.equal(
      (
        await post("/tests", {
          ...creation,
          operationId: randomUUID(),
          kinds: ["proof"],
        })
      ).status,
      400,
    );
    const next = { operationId: randomUUID(), version: 0 };
    failGeneration = true;
    assert.equal((await post(`/tests/${id}/next`, next)).status, 503);
    const parent = await db.collection("math_tests").doc(id).get();
    const plan = parent.get("pendingPlans");
    assert.equal(plan[0].primaryObjectiveId, "position");
    assert.equal(
      (
        await db
          .collection("math_tests")
          .doc(id)
          .collection("objectiveProgress")
          .get()
      ).size,
      0,
    );
    failGeneration = false;
    r = await post(`/tests/${id}/next`, next);
    assert.equal(r.status, 200);
    let state = r.data;
    assert.equal(state.questions[0].rubricItems, undefined);
    assert.equal(state.pendingPlans, undefined);
    assert.deepEqual(
      (
        await db.collection("math_tests").doc(id).collection("plans").get()
      ).docs[0].get("plans"),
      plan,
    );
    const progress = async () =>
      (
        await db
          .collection("math_tests")
          .doc(id)
          .collection("objectiveProgress")
          .doc("position")
          .get()
      ).data()!;
    assert.equal((await progress()).presented, 1);
    assert.equal(
      (await post(`/tests/${id}/next`, next)).data.version,
      state.version,
    );
    const assistance = {
      operationId: randomUUID(),
      version: state.version,
      questionId: "q1",
      kind: "solution_view",
    };
    r = await post(`/tests/${id}/assistance`, assistance);
    assert.equal(r.status, 200);
    state = r.data;
    assert.equal((await progress()).assistanceStatus, "viewed");
    assert.equal(
      (await post(`/tests/${id}/assistance`, assistance)).data.version,
      state.version,
    );
    const grade = {
      operationId: randomUUID(),
      version: state.version,
      questionId: "q1",
      text: "x=0",
    };
    r = await post(`/tests/${id}/answer`, grade);
    assert.equal(r.status, 200);
    state = r.data;
    assert.equal((await progress()).partial, 1);
    assert.equal((await progress()).submitted, 1);
    await post(`/tests/${id}/answer`, grade);
    assert.equal((await progress()).submitted, 1);
    await db
      .collection("math_books")
      .doc(bookId)
      .update({ title: "New edition", revision: "next" });
    r = await post(`/tests/${id}/next`, {
      operationId: randomUUID(),
      version: state.version,
    });
    assert.equal(r.status, 200);
    state = r.data;
    assert.equal(state.book.title, "Physics fixture");
    r = await post(`/tests/${id}/next`, {
      operationId: randomUUID(),
      version: state.version,
      draft: "unfinished",
    });
    assert.equal(r.status, 200);
    state = r.data;
    assert.equal((await progress()).skipped, 1);
    assert.equal((await progress()).incorrect, 0);
    assert.equal((await progress()).presented, 3);
    r = await post(`/tests/${id}/state`, {
      operationId: randomUUID(),
      version: state.version,
      action: "finish",
    });
    assert.equal(r.status, 200);
    assert.equal((await progress()).skipped, 2);
    assert.equal(
      (
        await db
          .collection("math_learning_evidence")
          .doc(bookId)
          .collection("objectives")
          .doc("position")
          .get()
      ).get("presented"),
      3,
    );
  });

  await test("concurrent sessions aggregate shared objective evidence without lost updates", async () => {
    await db.collection("math_books").doc(bookId).set(book);
    const sessions = await Promise.all(
      [0, 1].map(async (n) => {
        const id = `${bookId}-parallel-${n}`;
        ids.push(id);
        let r = await post("/tests", {
          operationId: id,
          bookId,
          chapterIds: ["c1"],
          assessmentVersion: 2,
          taskKinds: ["compute"],
          mode: "continuous",
          difficulty: "standard",
        });
        assert.equal(r.status, 200);
        r = await post(`/tests/${id}/next`, {
          operationId: randomUUID(),
          version: r.data.version,
        });
        assert.equal(r.status, 200);
        return r.data;
      }),
    );
    await Promise.all(
      sessions.map(async (t) => {
        const r = await post(`/tests/${t.id}/answer`, {
          operationId: randomUUID(),
          version: t.version,
          questionId: "q1",
          text: "x=0",
        });
        assert.equal(r.status, 200);
      }),
    );
    const shared = await db
      .collection("math_learning_evidence")
      .doc(bookId)
      .collection("objectives")
      .doc("position")
      .get();
    assert.equal(shared.get("presented"), 5);
    assert.equal(shared.get("submitted"), 3);
    assert.equal(shared.get("partial"), 3);
  });
  await test("concurrent publications compare the old revision instead of overwriting another publisher", async () => {
    const candidates = [1, 2].map((n) => ({
      ...book,
      title: `Edition ${n}`,
      revision: `${book.revision}-${n}`,
      publicationId: `${book.publicationId}-${n}`,
    }));
    extraPublications.push(...candidates.map((c) => c.publicationId!));
    const results = await Promise.allSettled(
      candidates.map((b) =>
        publishMathBook(db, b, [source], curriculum, false),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const current = (
      await db.collection("math_books").doc(bookId).get()
    ).data() as MathBook;
    assert.ok(candidates.some((c) => c.revision === current.revision));
    assert.equal((await loadMathCurriculum(db, current)).objectives.length, 1);
  });
} finally {
  for (const id of extraPublications)
    await db.collection("math_publications").doc(id).delete();
  for (const id of ids)
    await db.recursiveDelete(db.collection("math_tests").doc(id));
  await db.recursiveDelete(db.collection("math_learning_evidence").doc(bookId));
  await db.collection("math_books").doc(bookId).delete();
  await db.collection("math_publications").doc(book.publicationId!).delete();
  await db.recursiveDelete(
    db.collection("math_curriculum_versions").doc(curriculum.revision),
  );
  await db.collection("math_chapter_versions").doc(source.versionId).delete();
  await app.close();
  await db.terminate();
}
