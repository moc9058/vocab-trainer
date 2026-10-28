import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linearAlgebraFixture,
  request,
  validCandidate,
} from "../math-fixtures.js";
import { resolveScope } from "../../../src/math-scope.js";
import { contentHash } from "../../../src/math-schema.js";
import type {
  MathJob,
  MathTest,
  StoredSolution,
  Scope,
} from "../../../src/math-types.js";
if (
  process.env.FIRESTORE_PROJECT !== "demo-vocab-math" ||
  process.env.FIRESTORE_DATABASE_ID !== "(default)" ||
  !process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error("Unsafe mathematics test target");
mock.module("../../../src/llm.js", {
  namedExports: {
    resolveModel: async () => "fixture-model",
    callLLM: async () => {
      throw new Error("Unexpected real LLM call");
    },
    recordUsage: async () => {},
  },
});
const { mathRoutes } = await import("../../../src/routes/math.js");
const { mathWorkerRoutes } = await import("../../../src/routes/math-worker.js");
const {
  collection,
  mathDb: db,
  publishCatalog,
  activeCatalogId,
  loadCatalog,
  testView,
  getScope,
  requiredDoc,
  readDoc,
} = await import("../../../src/math-store.js");
const { runMathTask, claimMathJob, reconcileMathJobs } =
  await import("../../../src/math-jobs.js");
const { applyTestOperation } = await import("../../../src/math-operations.js");
const { buildCatalog } = await import("../../../src/math-content.js");
const fixture = await linearAlgebraFixture();
const app = Fastify();
await app.register(mathRoutes, { prefix: "/api/math" });
await app.register(mathWorkerRoutes, { prefix: "/internal/math" });
before(async () => {
  for (const name of [
    "settings",
    "catalogs",
    "unit_revisions",
    "concept_revisions",
    "source_revisions",
    "source_documents",
    "provenance_revisions",
    "scope_previews",
    "tests",
    "jobs",
    "operation_receipts",
    "foundation_acceptances",
    "learning_states",
    "problem_reports",
  ])
    await db.recursiveDelete(collection(name));
  await db.collection("config").doc("vocabulary").set({ languages: [] });
  await publishCatalog(
    fixture.catalog,
    fixture.artifacts,
    fixture.provenances,
    null,
  );
});
after(async () => {
  await app.close();
  await db.terminate();
});
async function api(
  method: string,
  path: string,
  payload?: unknown,
  status = 200,
) {
  const r = await app.inject({
    method: method as any,
    url: `/api/math${path}`,
    payload,
  });
  assert.equal(r.statusCode, status, r.body);
  return r.json();
}
async function createTest() {
  const preview = await api("POST", "/scope-previews", request());
  return api(
    "POST",
    "/tests",
    {
      previewId: preview.id,
      scopeHash: preview.scopeHash,
      acceptance: preview.requiredAcceptance,
      operationId: randomUUID(),
    },
    202,
  );
}
const llm = async (feature: string, system: string, input: any) => {
  if (feature === "generate") {
    const scope = resolveScope(request(), fixture.catalog);
    return { result: validCandidate(fixture.catalog, scope, scope.plans[0]) };
  }
  if (feature === "grade") {
    return {
      state: "graded",
      criteria: [
        {
          criterionId: "all-conditions",
          awardedPoints: 100,
          maxPoints: 100,
          feedback: "All conditions checked.",
          evidenceRanges: [{ start: 0, end: 3, quote: "yes" }],
          citationIds: [],
        },
      ],
      outsideMethodUsed: false,
      objectiveEvidence: [
        { objectiveId: "apply-subspace-test", demonstrated: true },
      ],
      correctnessScore: 100,
      gradeSource: "ai",
      feedback: "The three subspace conditions hold.",
    };
  }
  if (system.startsWith("Independently"))
    return {
      answerMarkdown: "Yes, contains zero and closed under both operations.",
      usedCapabilities: resolveScope(request(), fixture.catalog).plans[0]
        .allowedCapabilities,
      sufficientConditions: true,
      circular: false,
      explanation: "All three conditions.",
    };
  return {
    valid: true,
    matchesIndependentSolution: true,
    conditionsComplete: true,
    withinScope: true,
    nonCircular: true,
    difficultyMatches: true,
    reason: "Verified.",
  };
};
async function runJob(id: string, limit = 10) {
  for (let i = 0; i < limit; i++) {
    const job = await requiredDoc<MathJob>(collection("jobs").doc(id));
    if (["succeeded", "failed", "cancelled"].includes(job.state)) return job;
    await runMathTask(
      { jobId: id, generation: job.generation, sequence: job.sequence },
      llm as any,
    );
  }
  throw new Error("Job did not finish");
}
test("catalogs publish atomically, immutable old versions survive movements and stale publish fails", async () => {
  assert.equal(await activeCatalogId(), fixture.catalog.id);
  const copy = await loadCatalog(fixture.catalog.id);
  assert.equal(copy.concepts[0].citations[0].sourcePath.length, 3);
  await assert.rejects(
    () =>
      publishCatalog(
        fixture.catalog,
        fixture.artifacts,
        fixture.provenances,
        "0".repeat(64),
      ),
    /CATALOG_CHANGED/,
  );
  assert.equal(await activeCatalogId(), fixture.catalog.id);
});
test("strict Fastify schemas reject extra properties, bad IDs, sizes and cookie worker access", async () => {
  await api(
    "POST",
    "/scope-previews",
    { ...request(), allowedCapabilities: ["anything"] },
    400,
  );
  await api(
    "POST",
    "/tests",
    {
      previewId: "../escape",
      scopeHash: "bad",
      acceptance: [],
      operationId: "short",
    },
    400,
  );
  for (const route of ["/internal/math/run", "/internal/math/reconcile"]) {
    const r = await app.inject({
      method: "POST",
      url: route,
      headers: { cookie: "session=not-oidc" },
      payload: { jobId: "whatever", generation: 1, sequence: 0 },
    });
    assert.equal(r.statusCode, 401);
  }
});
test("scope confirmation and creation receipts are atomic and reject changed operation payloads", async () => {
  const preview = await api("POST", "/scope-previews", request()),
    operationId = randomUUID(),
    body = {
      previewId: preview.id,
      scopeHash: preview.scopeHash,
      acceptance: preview.requiredAcceptance,
      operationId,
    };
  await api("POST", "/tests", { ...body, acceptance: [] }, 422);
  const created = await api("POST", "/tests", body, 202);
  assert.deepEqual(await api("POST", "/tests", body, 202), created);
  await api(
    "POST",
    "/tests",
    { ...body, acceptance: [...body.acceptance, "outside:foo"] },
    409,
  );
  await applyTestOperation(created.testId, "cancel", {
    expectedRevision: 0,
    operationId: randomUUID(),
  });
});
test("generation checkpoints are leased, duplicate tasks are harmless, GET does not leak private solutions", async () => {
  const created = await createTest(),
    job = await requiredDoc<MathJob>(collection("jobs").doc(created.jobId));
  const claimed = await claimMathJob({
    jobId: job.id,
    generation: job.generation,
    sequence: job.sequence,
  });
  assert(claimed);
  assert.equal(
    await claimMathJob({
      jobId: job.id,
      generation: job.generation,
      sequence: job.sequence,
    }),
    null,
  );
  await collection("jobs").doc(job.id).update({ lease: null });
  const finished = await runJob(job.id);
  assert.equal(finished.state, "succeeded");
  const view = await api("GET", `/tests/${created.testId}`);
  assert.equal(view.state, "ready");
  assert.equal(view.questions.length, 1);
  assert(!JSON.stringify(view).includes("finalAnswerMarkdown"));
  assert(!JSON.stringify(view).includes("strategyMarkdown"));
  assert(!JSON.stringify(view).includes("rubric"));
  await runMathTask(
    { jobId: job.id, generation: job.generation, sequence: job.sequence },
    llm as any,
  );
  assert.equal((await testView(created.testId)).questions.length, 1);
});
test("draft → submit → completion, response-loss replay, grades and overrides remain idempotent", async () => {
  const created = await createTest();
  await runJob(created.jobId);
  let view = await testView(created.testId);
  const started = await api("POST", `/tests/${view.id}/start`, {
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
  view = await testView(view.id);
  const questionId = view.questionIds[0],
    draftId = randomUUID(),
    draft = {
      text: "yes, zero and both closures",
      expectedDraftRevision: 0,
      operationId: draftId,
    };
  const saved = await api(
    "PUT",
    `/tests/${view.id}/drafts/${questionId}`,
    draft,
  );
  assert.deepEqual(
    await api("PUT", `/tests/${view.id}/drafts/${questionId}`, draft),
    saved,
  );
  await api(
    "PUT",
    `/tests/${view.id}/drafts/${questionId}`,
    { ...draft, operationId: randomUUID() },
    409,
  );
  const body = {
    questionId,
    sittingId: view.currentSittingId,
    answerText: draft.text,
    paper: false,
    expectedRevision: view.revision,
    operationId: randomUUID(),
  };
  const submitted = await api("POST", `/tests/${view.id}/attempts`, body, 202);
  assert.deepEqual(
    await api("POST", `/tests/${view.id}/attempts`, body, 202),
    submitted,
  );
  assert.equal((await testView(view.id)).state, "completed");
  await runJob(submitted.jobId);
  view = await testView(view.id);
  assert.equal(view.score, 100);
  assert.equal(view.attempts.length, 1);
  const reveal = await api("POST", `/tests/${view.id}/reveal`, {
    questionId,
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
  assert(
    reveal.solution.citations.every((c: any) => c.sourcePath.length === 3),
  );
  const override = {
    expectedGradeVersion: 1,
    criterionScores: [{ criterionId: "all-conditions", points: 75 }],
    reason: "User correction",
    operationId: randomUUID(),
  };
  await api(
    "PUT",
    `/tests/${view.id}/attempts/${submitted.attemptId}/assessment`,
    override,
  );
  await api(
    "PUT",
    `/tests/${view.id}/attempts/${submitted.attemptId}/assessment`,
    override,
  );
  view = await testView(view.id);
  assert.equal(view.score, 75);
  assert.equal(view.attempts[0].history.length, 1);
  await api("POST", `/tests/${view.id}/questions/${questionId}/invalidate`, {
    expectedRevision: view.revision,
    reason: "test invalidation",
    operationId: randomUUID(),
  });
  view = await testView(view.id);
  assert.equal(view.maxScore, 0);
  assert.equal(view.state, "completed");
  await api(
    "POST",
    `/tests/${view.id}/resume`,
    { expectedRevision: view.revision, operationId: randomUUID() },
    409,
  );
});
test("early end/review boundaries and a fresh sitting do not erase attempts or reopen completed tests", async () => {
  const created = await createTest();
  await runJob(created.jobId);
  let view = await testView(created.testId);
  await api("POST", `/tests/${view.id}/start`, {
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
  view = await testView(view.id);
  const oldSitting = view.currentSittingId;
  await api("POST", `/tests/${view.id}/end-sitting`, {
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
  await api("POST", `/tests/${view.id}/review`, {
    reviewRevision: 0,
    action: "start",
    operationId: randomUUID(),
  });
  view = await testView(view.id);
  assert.equal(view.sitting?.review.state, "completed");
  await api("POST", `/tests/${view.id}/resume`, {
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
  view = await testView(view.id);
  assert.notEqual(view.currentSittingId, oldSitting);
  assert.equal(view.state, "in_progress");
  await api("POST", `/tests/${view.id}/skip`, {
    questionId: view.questionIds[0],
    expectedRevision: view.revision,
    reason: "explicit skip",
    operationId: randomUUID(),
  });
  view = await testView(view.id);
  assert.equal(view.state, "completed");
  assert(view.attempts[0].skipped);
});
test("known bad candidates exhaust exactly three candidates and retain failure without exposing question", async () => {
  const created = await createTest();
  for (let i = 0; i < 3; i++) {
    const job = await requiredDoc<MathJob>(
      collection("jobs").doc(created.jobId),
    );
    await collection("jobs").doc(job.id).update({ nextWakeAt: 0 });
    await runMathTask(
      { jobId: job.id, generation: job.generation, sequence: job.sequence },
      async () => ({
        result: {
          status: "IMPOSSIBLE_WITH_SCOPE",
          reason: "No valid question",
        },
      }),
    );
  }
  const view = await testView(created.testId);
  assert.equal(view.state, "generation_failed");
  assert.equal(view.questions.length, 0);
  await api(
    "POST",
    `/tests/${view.id}/accept-partial`,
    {
      expectedRevision: view.revision,
      acceptedQuestionIds: [],
      operationId: randomUUID(),
    },
    400,
  );
  await applyTestOperation(created.testId, "cancel", {
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
});

test("catalog changes after preview return 409, retained catalogs and tests survive a tree move and rollback", async () => {
  const preview = await api("POST", "/scope-previews", request()),
    oldTest = await createTest();
  await runJob(oldTest.jobId);
  const moved = structuredClone(fixture.catalog);
  moved.nodes.find((n) => n.id === "section-subspaces")!.title =
    "Reviewed subsection title";
  const { id, ...body } = moved;
  moved.id = contentHash(body);
  await publishCatalog(
    moved,
    fixture.artifacts,
    fixture.provenances,
    fixture.catalog.id,
  );
  await api(
    "POST",
    "/tests",
    {
      previewId: preview.id,
      scopeHash: preview.scopeHash,
      acceptance: preview.requiredAcceptance,
      operationId: randomUUID(),
    },
    409,
  );
  assert.equal(
    (await loadCatalog(fixture.catalog.id)).nodes.find(
      (n) => n.id === "section-subspaces",
    )!.title,
    "Subspaces",
  );
  assert.equal((await getScope(oldTest.testId)).catalogId, fixture.catalog.id);
  const { rollbackCatalog } = await import("../../../src/math-store.js");
  await rollbackCatalog(fixture.catalog.id, moved.id);
  assert.equal(await activeCatalogId(), fixture.catalog.id);
});
test("cancel rejects a late worker result; reconciler replaces a lost dispatch with a new sequence", async () => {
  const created = await createTest();
  let release!: (value: unknown) => void, entered!: () => void;
  const wait = new Promise<void>((r) => (entered = r));
  const delayed = runMathTask(
    { jobId: created.jobId, generation: 1, sequence: 0 },
    async () => {
      entered();
      return new Promise((r) => (release = r));
    },
  );
  await wait;
  const view = await testView(created.testId);
  await applyTestOperation(view.id, "cancel", {
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
  const scope = resolveScope(request(), fixture.catalog);
  release({ result: validCandidate(fixture.catalog, scope, scope.plans[0]) });
  await delayed;
  assert.equal((await testView(view.id)).state, "cancelled");
  assert.equal((await testView(view.id)).questions.length, 0);
  const recovery = await createTest();
  await reconcileMathJobs(false);
  const recovered = await requiredDoc<MathJob>(
    collection("jobs").doc(recovery.jobId),
  );
  assert(recovered.sequence > 0);
  assert.equal(
    await claimMathJob({ jobId: recovery.jobId, generation: 1, sequence: 0 }),
    null,
  );
  assert.equal((await runJob(recovery.jobId)).state, "succeeded");
});
test("persisted job budget cannot be reset by retry generation", async () => {
  const created = await createTest();
  await collection("jobs").doc(created.jobId).update({ tokens: 1_500_000 });
  await runMathTask({ jobId: created.jobId, generation: 1, sequence: 0 });
  let job = await requiredDoc<MathJob>(collection("jobs").doc(created.jobId));
  assert.equal(job.state, "failed");
  assert.equal(job.lastError, "MATH_JOB_BUDGET");
  assert.equal(job.calls, 0);
  let view = await testView(created.testId);
  await applyTestOperation(view.id, "retry-generation", {
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
  job = await requiredDoc<MathJob>(collection("jobs").doc(created.jobId));
  assert.equal(job.tokens, 1_500_000);
  await runMathTask({
    jobId: job.id,
    generation: job.generation,
    sequence: job.sequence,
  });
  job = await requiredDoc<MathJob>(collection("jobs").doc(job.id));
  assert.equal(job.state, "failed");
});

test('re-review of unchanged content reuses semantic and provenance revisions without overwriting older receipts',async()=>{const next=await linearAlgebraFixture();assert.equal(next.compiled.provenanceHash,fixture.compiled.provenanceHash);assert.equal(next.catalog.concepts[0].revisionId,fixture.catalog.concepts[0].revisionId);assert.notEqual(next.compiled.unit.reviewHash,fixture.compiled.unit.reviewHash);await publishCatalog(next.catalog,next.artifacts,next.provenances,fixture.catalog.id);const reviews=await collection('provenance_revisions').doc(fixture.compiled.provenanceHash).collection('reviews').get();assert.equal(reviews.size,2);const {rollbackCatalog}=await import('../../../src/math-store.js');await rollbackCatalog(fixture.catalog.id,next.catalog.id);});
