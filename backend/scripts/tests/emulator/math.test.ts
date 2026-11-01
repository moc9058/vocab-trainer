import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type {
  MathBook,
  MathTest,
  Curriculum,
  MathSource,
} from "../../../src/math-types.js";
import { mathHash, mathPromptHash } from "../../../src/math-core.js";
import { canonical, curriculumRevision } from "../../../src/math-curriculum.js";
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Emulator required");
let failGenerate = false,
  failGrade = false,
  duplicate = false,
  blocked: (() => Promise<void>) | undefined;
const generationBooks: string[] = [],
  gradingBooks: string[] = [];
mock.module("../../../src/llm.ts", {
  namedExports: { resolveModel: async () => "mock-model" },
});
mock.module("../../../src/math-llm.ts", {
  namedExports: {
    generateMathQuestions: async (t: MathTest, sources: MathSource[]) => {
      generationBooks.push(t.book.id);
      assert.equal(t.count, 1);
      assert.ok(sources.every((s) => s.bookId === t.book.id));
      if (blocked) {
        const hold = blocked;
        blocked = undefined;
        await hold();
      }
      if (failGenerate) throw new Error("Generation unavailable");
      return [
        {
          id: "q1",
          schemaVersion: 2,
          chapterId: t.chapterIds[0],
          primaryObjectiveId: "same-objective",
          taskKind: "compute",
          kind: "calculation",
          heading: "1.1 Test",
          prompt: `${t.book.id} question ${duplicate ? 0 : (t.generatedCount ?? 0)}`,
          solution: "1/2",
          rubric: "private rubric",
          rubricItems: [{ id: "r", criterion: "Private criterion", weight: 1 }],
          publicationId: t.publicationId,
          curriculumRevision: t.curriculumRevision,
        },
      ];
    },
    gradeMathAnswer: async (
      t: MathTest,
      q: { bookId?: string },
      _text: string,
      sources: MathSource[],
    ) => {
      gradingBooks.push(t.book.id);
      assert.ok(sources.every((s) => s.bookId === t.book.id));
      if (q.bookId) assert.equal(q.bookId, t.book.id);
      if (failGrade) throw new Error("Grading unavailable");
      return { verdict: "partial", feedback: "Check the units." };
    },
  },
});
const { db } = await import("../../../src/firestore.js");
const { publishMathBook } = await import("../../../src/math-publication.js");
const { scopeKey } = await import("../../../src/math-scopes.js");
const { mathPromptVersion } = await import(
  "../../../src/math-prompt-loader.js"
);
const { default: routes } = await import("../../../src/routes/math.js");
const app = Fastify();
await app.register(routes, { prefix: "/api/math" });
const prefix = `multi-${randomUUID()}`;
const fixtures: {
  book: MathBook;
  sources: MathSource[];
  curriculum: Curriculum;
}[] = [];
const sessions: string[] = [];
const post = async (path: string, payload: unknown) => {
  const r = await app.inject({
    method: "POST",
    url: `/api/math${path}`,
    payload,
  });
  return { status: r.statusCode, data: r.json() };
};
const get = async (id: string) =>
  (await app.inject(`/api/math/tests/${id}`)).json() as MathTest;
const op = (t: MathTest, extra: object = {}) => ({
  operationId: randomUUID(),
  version: t.version,
  ...extra,
});
async function create(indices = [0]) {
  const id = `${prefix}-${sessions.length}`;
  sessions.push(id);
  const r = await post("/tests", {
    operationId: id,
    scopes: indices.map((i) => ({
      bookId: fixtures[i].book.id,
      chapterIds: ["c1"],
    })),
    difficulty: "standard",
    taskKinds: ["compute"],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data as MathTest;
}
async function next(t: MathTest) {
  const r = await post(`/tests/${t.id}/next`, op(t));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data as MathTest;
}
async function reveal(t: MathTest) {
  const r = await post(
    `/tests/${t.id}/reveal`,
    op(t, { questionId: t.currentQuestionId }),
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data as MathTest;
}
try {
  for (let i = 0; i < 3; i++) {
    const id = `${prefix}-book${i}`;
    const source: MathSource = {
      id: "c1",
      number: 1,
      title: `Chapter ${i}`,
      bookId: id,
      markdown: "# 1.1 Test\nA half equals 1/2.",
      versionId: `${id}-source`,
    };
    const curriculum: Curriculum = {
      schemaVersion: 2,
      bookId: id,
      revision: "",
      instructionLanguage: "en",
      sourceLanguage: "en",
      guidance: "Use exact rational arithmetic from the source.",
      sources: [
        {
          chapterId: "c1",
          file: "Example/md/1. Test.md",
          sha256: mathHash(source.markdown),
        },
      ],
      objectives: [
        {
          id: "same-objective",
          chapterId: "c1",
          statement: "Compute a rational quantity.",
          ability: "application",
          supportedTaskKinds: ["compute"],
          sourceRefs: [
            { chapterId: "c1", section: "1.1", heading: "1.1 Test" },
          ],
          prerequisiteObjectiveIds: [],
          requiredBackground: [],
          successCriteria: [
            { id: "r", criterion: "Give an exact rational value." },
          ],
          scopeConstraints: [],
          commonErrors: [],
          status: "active",
        },
      ],
    };
    curriculum.revision = curriculumRevision(curriculum);
    const book: MathBook = {
      id,
      subjectId: "math",
      subjectTitle: "Mathematics",
      title: `Textbook ${i}`,
      language: i === 1 ? "ja" : "en",
      revision: "",
      chapters: [
        {
          id: "c1",
          number: 1,
          title: source.title,
          versionId: source.versionId,
        },
      ],
      curriculumRevision: curriculum.revision,
      subjectProfile: {
        version: "math-v1",
        subject: "mathematics",
        constraints: [],
      },
    };
    book.revision = mathHash(canonical(book));
    book.publicationId = book.revision;
    fixtures.push({ book, sources: [source], curriculum });
    await publishMathBook(db, book, [source], curriculum, false);
  }
  await test("new sessions are continuous; fixed count and batch generation have been removed", async () => {
    const t = await create([0, 1]);
    assert.equal(t.mode, "continuous");
    assert.equal(t.phase, "ready");
    assert.equal(t.scopes!.length, 2);
    assert.equal(
      (
        await post("/tests", {
          operationId: randomUUID(),
          bookId: fixtures[0].book.id,
          chapterIds: ["c1"],
          difficulty: "standard",
          count: 3,
        })
      ).status,
      400,
    );
    assert.equal((await post(`/tests/${t.id}/generate`, op(t))).status, 404);
    const r = await post("/tests", {
      operationId: randomUUID(),
      scopes: [{ bookId: fixtures[0].book.id, chapterIds: [] }],
      difficulty: "standard",
    });
    assert.equal(r.status, 400);
    for (const scopes of [[], [0, 0].map(() => ({ bookId: fixtures[0].book.id, chapterIds: ["c1"] }))]) {
      assert.equal((await post("/tests", { operationId: randomUUID(), scopes, difficulty: "standard" })).status, 400);
    }
    assert.equal((await post("/tests", {
      operationId: randomUUID(), scopes: [{ bookId: fixtures[0].book.id, chapterIds: ["c1"] }],
      difficulty: "standard", taskKinds: ["prove"],
    })).status, 422);
  });
  await test("reveal stays on the question, is durable and idempotent, and never grades or skips", async () => {
    let t = await next(await create());
    const body = op(t, {
      questionId: t.currentQuestionId,
      draft: "Private draft",
    });
    const original = t.currentQuestionId;
    const r = await post(`/tests/${t.id}/reveal`, body);
    assert.equal(r.status, 200);
    t = r.data;
    assert.equal(t.currentQuestionId, original);
    assert.equal(t.phase, "solution");
    assert.equal(t.stats!.revealed, 1);
    assert.equal(t.stats!.answered, 0);
    assert.equal(t.draft, "Private draft");
    assert.equal(
      (await post(`/tests/${t.id}/reveal`, body)).data.stats.revealed,
      1,
    );
    assert.equal((await get(t.id)).phase, "solution");
    assert.equal(t.questions[0].rubric, undefined);
    t = await next(t);
    const history = (
      await app.inject(`/api/math/tests/${t.id}/questions`)
    ).json();
    assert.equal(history.items[0].question.revealedAt !== undefined, true);
    assert.equal(history.items[0].answer.submitted, false);
    const shared = await db
      .collection("math_tests")
      .doc(t.id)
      .collection("objectiveProgress")
      .doc(scopeKey(fixtures[0].book.id, "same-objective"))
      .get();
    assert.equal(shared.get("revealed"), 1);
    assert.equal(shared.get("submitted"), 0);
    assert.equal(shared.get("skipped"), 0);
  });
  await test("book draw balances presentations and colliding chapter/objective IDs stay distinct", async () => {
    let t = await create([0, 1]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 8; i++) {
      t = await next(t);
      const book = t.questions[0].bookId!;
      counts.set(book, (counts.get(book) ?? 0) + 1);
      assert.ok(
        Math.abs(
          (counts.get(fixtures[0].book.id) ?? 0) -
            (counts.get(fixtures[1].book.id) ?? 0),
        ) <= 1,
      );
      t = await reveal(t);
    }
    assert.deepEqual([...counts.values()], [4, 4]);
    const progress = (
      await app.inject(`/api/math/tests/${t.id}/objectives`)
    ).json();
    assert.equal(progress.length, 2);
    assert.equal(
      new Set(progress.map((p: { bookId: string }) => p.bookId)).size,
      2,
    );
  });
  await test("scope changes affect only the next question; source versions and drafts stay frozen", async () => {
    let t = await next(await create());
    const old = t.questions[0];
    const change = op(t, {
      scopes: [{ bookId: fixtures[1].book.id, chapterIds: ["c1"] }],
      draft: "Keep this draft",
    });
    let r = await post(`/tests/${t.id}/scope`, change);
    assert.equal(r.status, 200);
    t = r.data;
    assert.equal(t.currentQuestionId, old.id);
    assert.equal(t.questions[0].bookId, old.bookId);
    assert.equal(t.draft, "Keep this draft");
    assert.equal(t.scopeRevision, 1);
    assert.equal(
      (await post(`/tests/${t.id}/scope`, change)).data.scopeRevision,
      1,
    );
    r = await post(
      `/tests/${t.id}/answer`,
      op(t, { questionId: old.id, text: "1/2" }),
    );
    assert.equal(r.status, 200);
    assert.equal(gradingBooks.at(-1), fixtures[0].book.id);
    t = r.data;
    t = await next(t);
    assert.equal(t.questions[0].bookId, fixtures[1].book.id);
    // Re-add a removed book after its live pointer changes: use the pinned snapshot.
    await db
      .collection("math_books")
      .doc(fixtures[0].book.id)
      .update({ revision: "changed", title: "Changed live title" });
    r = await post(
      `/tests/${t.id}/scope`,
      op(t, { scopes: [{ bookId: fixtures[0].book.id, chapterIds: ["c1"] }] }),
    );
    assert.equal(r.status, 200);
    t = r.data;
    assert.equal(t.scopes![0].book.title, "Textbook 0");
    t = await reveal(t);
    const gradeRemoved=await post(`/tests/${t.id}/answer`,op(t,{questionId:t.currentQuestionId,text:"1/2"}));
    assert.equal(gradeRemoved.status,200);assert.equal(gradingBooks.at(-1),fixtures[1].book.id);t=gradeRemoved.data;
    t = await next(t);
    assert.equal(t.questions[0].bookTitle, "Textbook 0");
    r = await post(
      `/tests/${t.id}/scope`,
      op(t, {
        scopes: [{ bookId: fixtures[0].book.id, chapterIds: ["missing"] }],
      }),
    );
    assert.equal(r.status, 400);
    assert.equal((await get(t.id)).scopeRevision, 2);
    await db
      .collection("math_books")
      .doc(fixtures[0].book.id)
      .set(fixtures[0].book);
  });
  await test("generation and grading failures preserve progress; persisted plans retry without a redraw", async () => {
    let t = await reveal(await next(await create()));
    const body = op(t);
    failGenerate = true;
    assert.equal((await post(`/tests/${t.id}/next`, body)).status, 503);
    t = await get(t.id);
    assert.equal(t.phase, "solution");
    assert.equal(t.stats!.revealed, 1);
    const saved = (await db.collection("math_tests").doc(t.id).get()).get(
      "pendingPlans",
    );
    assert.equal(saved.length, 1);
    failGenerate = false;
    const r = await post(`/tests/${t.id}/next`, body);
    assert.equal(r.status, 200);
    t = r.data;
    assert.equal(t.generatedCount, 2);
    const answer = op(t, {
      questionId: t.currentQuestionId,
      text: "My answer",
    });
    failGrade = true;
    assert.equal((await post(`/tests/${t.id}/answer`, answer)).status, 503);
    assert.equal((await get(t.id)).draft, "My answer");
    failGrade = false;
    assert.equal(
      (await post(`/tests/${t.id}/answer`, answer)).data.stats.answered,
      1,
    );
    assert.equal(
      (await post(`/tests/${t.id}/answer`, answer)).data.stats.answered,
      1,
    );
  });
  await test("an old failed plan cannot survive a successful scope edit", async () => {
    let t = await create();
    failGenerate = true;
    assert.equal((await post(`/tests/${t.id}/next`, op(t))).status, 503);
    failGenerate = false;
    t = await get(t.id);
    const r = await post(
      `/tests/${t.id}/scope`,
      op(t, { scopes: [{ bookId: fixtures[1].book.id, chapterIds: ["c1"] }] }),
    );
    assert.equal(r.status, 200);
    t = await next(r.data);
    assert.equal(t.questions[0].bookId, fixtures[1].book.id);
  });
  await test("lazy fixed migration keeps answered/current questions, drops future questions and generates the next", async () => {
    const modern = await create();
    const { scopes: _scopes, scopeRevision: _revision, ...base } = modern;
    const q = (n: number) => ({
      id: `q${n}`,
      number: n,
      chapterId: "c1",
      kind: "calculation",
      prompt: `Old ${n}`,
      solution: "1/2",
      rubric: "private",
    });
    await db
      .collection("math_tests")
      .doc(base.id)
      .set({
        ...base,
        mode: "fixed",
        status: "active",
        phase: "question",
        currentQuestionId: "q2",
        count: 3,
        questions: [q(1), q(2), q(3)],
        answers: {
          q1: {
            text: "answer",
            operationId: "old",
            grade: { verdict: "correct", feedback: "Correct" },
          },
        },
        draft: "Old draft",
      });
    let t = await get(base.id);
    assert.equal(t.mode, "continuous");
    assert.equal(t.generatedCount, 2);
    assert.equal(t.currentQuestionId, "q2");
    assert.equal(t.draft, "Old draft");
    assert.equal(t.stats!.answered, 1);
    assert.equal(t.stats!.correct, 1);
    const history = (
      await app.inject(`/api/math/tests/${t.id}/questions`)
    ).json();
    assert.equal(history.items.length, 2);
    assert.equal(history.items[0].answer.text, "answer");
    assert.equal(history.items[1].question.prompt, "Old 2");
    const version = t.version;
    assert.equal((await get(t.id)).version, version);
    t = await reveal(t);
    t = await next(t);
    assert.equal(t.currentQuestionId, "q3");
    assert.notEqual(t.questions[0].prompt, "Old 3");
  });
  await test("completed fixed tests keep all history and can never reopen", async () => {
    const t = await create();
    const q = {
      id: "q1",
      chapterId: "c1",
      kind: "proof",
      prompt: "Historical",
      solution: "Proof",
      rubric: "private",
    };
    await db
      .collection("math_tests")
      .doc(t.id)
      .set({
        ...t,
        mode: "fixed",
        status: "completed",
        count: 2,
        questions: [q, { ...q, id: "q2" }],
        answers: {
          q1: {
            text: "old",
            operationId: "old",
            grade: { verdict: "partial", feedback: "Old feedback" },
          },
        },
      });
    const old = await get(t.id);
    assert.equal(old.status, "completed");
    assert.equal(
      (await app.inject(`/api/math/tests/${t.id}/questions`)).json().items
        .length,
      2,
    );
    assert.equal((await post(`/tests/${t.id}/next`, op(old))).status, 409);
  });
  await test("stale tabs, in-flight scope edits and expired generation are fenced", async () => {
    let t = await next(await create());
    const results = await Promise.all(
      [0, 1].map(() =>
        post(
          `/tests/${t.id}/reveal`,
          op(t, { questionId: t.currentQuestionId }),
        ),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    t = await get(t.id);
    let start!: () => void, release!: () => void;
    const began = new Promise<void>((r) => (start = r)),
      held = new Promise<void>((r) => (release = r));
    blocked = async () => {
      start();
      await held;
    };
    const stale = post(`/tests/${t.id}/next`, op(t));
    await began;
    try {
      assert.equal(
        (
          await post(
            `/tests/${t.id}/scope`,
            op(t, {
              scopes: [{ bookId: fixtures[1].book.id, chapterIds: ["c1"] }],
            }),
          )
        ).status,
        409,
      );
      await db.collection("math_tests").doc(t.id).update({ "lock.until": 0 });
      const snapshot = await get(t.id);
      const fresh = await post(`/tests/${t.id}/next`, op(snapshot));
      assert.equal(fresh.status, 200);
      release();
      assert.equal((await stale).status, 409);
      assert.equal((await get(t.id)).version, fresh.data.version);
    } finally {
      release();
      await stale;
    }
  });
  await test("long history stays paginated and parent storage does not accumulate questions", async () => {
    let t = await create();
    for (let i = 0; i < 22; i++) {
      t = await next(t);
      t = await reveal(t);
    }
    const parent = (await db.collection("math_tests").doc(t.id).get()).data()!;
    assert.deepEqual(parent.questions, []);
    assert.deepEqual(parent.answers, {});
    assert.ok(Buffer.byteLength(JSON.stringify(parent)) < 12000);
    const first = (
        await app.inject(`/api/math/tests/${t.id}/questions`)
      ).json(),
      second = (
        await app.inject(
          `/api/math/tests/${t.id}/questions?after=${first.nextCursor}`,
        )
      ).json();
    assert.equal(first.items.length, 20);
    assert.equal(second.items.length, 2);
  });
} finally {
  for (const id of sessions)
    await db.recursiveDelete(db.collection("math_tests").doc(id));
  for (const f of fixtures) {
    await db.collection("math_books").doc(f.book.id).delete();
    await db
      .collection("math_publications")
      .doc(f.book.publicationId!)
      .delete();
    await db.recursiveDelete(
      db.collection("math_curriculum_versions").doc(f.curriculum.revision),
    );
    await db.recursiveDelete(
      db.collection("math_learning_evidence").doc(f.book.id),
    );
    for (const s of f.sources)
      await db.collection("math_chapter_versions").doc(s.versionId).delete();
  }
  await app.close();
  await db.terminate();
}
