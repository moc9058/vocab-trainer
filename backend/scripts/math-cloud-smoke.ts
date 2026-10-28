/** Explicit cloud verification. Creates one labelled test; never alters language data. */
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import Fastify from "fastify";
const { values } = parseArgs({
  options: {
    production: { type: "boolean" },
    project: { type: "string" },
    database: { type: "string" },
    "catalog-id": { type: "string" },
  },
});
if (
  !values.production ||
  values.project !== "vocab-trainer-490014" ||
  values.database !== "vocab-database" ||
  !values["catalog-id"] ||
  process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error(
    "Explicit production project, database and expected catalog ID are required",
  );
process.env.FIRESTORE_PROJECT = values.project;
process.env.FIRESTORE_DATABASE_ID = values.database;
const service = JSON.parse(
  execFileSync(
    "gcloud",
    [
      "run",
      "services",
      "describe",
      "vocab-trainer-backend",
      `--project=${values.project}`,
      "--region=asia-northeast1",
      "--format=json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ),
);
for (const entry of service.spec.template.spec.containers[0].env ?? [])
  if (entry.name.startsWith("MATH_") && typeof entry.value === "string")
    process.env[entry.name] = entry.value;
const backendUrl = service.status.url,
  frontendUrl =
    "https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app";
const { mathRoutes } = await import("../src/routes/math.js");
const { activeCatalogId, testView, collection, requiredDoc, mathDb } =
  await import("../src/math-store.js");
const { request } = await import("./tests/math-fixtures.js");
assert.equal(await activeCatalogId(), values["catalog-id"]);
const report: any = {
  startedAt: new Date().toISOString(),
  backendUrl,
  frontendUrl,
  catalogId: values["catalog-id"],
  checks: [],
  purpose: "verification",
};
const unauth = await fetch(`${backendUrl}/api/math/catalog`);
assert.equal(unauth.status, 401);
report.checks.push("Unauthenticated public API refused");
const worker = await fetch(`${backendUrl}/internal/math/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jobId: "invalid-smoke-job",
    generation: 1,
    sequence: 0,
  }),
});
assert.equal(worker.status, 401);
report.checks.push("Worker refuses requests without Google OIDC");
assert.equal((await fetch(`${frontendUrl}/math`)).status, 200);
report.checks.push("Cloud Run frontend serves mathematics route");
const app = Fastify();
await app.register(mathRoutes, { prefix: "/api/math" });
async function api(
  method: string,
  path: string,
  payload?: unknown,
  status = 200,
) {
  const response = await app.inject({
    method: method as "GET" | "POST" | "PUT",
    url: `/api/math${path}`,
    ...(payload === undefined
      ? {}
      : {
          payload: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
        }),
  });
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}
const preview = await api("POST", "/scope-previews", request());
assert.equal(preview.targetObjectiveIds.length, 1);
assert.equal(preview.prerequisites.length, 2);
const body = {
  previewId: preview.id,
  scopeHash: preview.scopeHash,
  acceptance: preview.requiredAcceptance,
  purpose: "verification",
  operationId: randomUUID(),
};
const created = await api("POST", "/tests", body, 202);
assert.deepEqual(await api("POST", "/tests", body, 202), created);
report.testId = created.testId;
report.generationJobId = created.jobId;
console.log(
  JSON.stringify({
    phase: "cloud-generation",
    testId: created.testId,
    jobId: created.jobId,
  }),
);
async function waitFor(predicate: (view: any) => boolean, phase: string) {
  const deadline = Date.now() + 12 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const view = await testView(created.testId),
      job = await requiredDoc<any>(
        collection("jobs").doc(
          phase === "generate"
            ? created.jobId
            : (view.attempts[0]?.jobId ?? created.jobId),
        ),
      );
    const state = `${view.state}/${job.state}/${job.stage}/${job.cursor}`;
    if (last !== state) {
      console.log(JSON.stringify({ phase, state, lastError: job.lastError }));
      last = state;
    }
    if (predicate(view)) return view;
    if (job.state === "failed" || view.state === "generation_failed")
      throw new Error(`Cloud ${phase} failed: ${job.lastError}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Cloud ${phase} timed out`);
}
try {
  let view = await waitFor((v) => v.state === "ready", "generate");
  report.checks.push(
    "Cloud Tasks → OIDC → Cloud Run generation, independent solve and comparison succeeded",
  );
  const publicResponse = await api("GET", `/tests/${view.id}`);
  assert(!JSON.stringify(publicResponse).includes("finalAnswerMarkdown"));
  assert(!JSON.stringify(publicResponse).includes("rubric"));
  report.checks.push("Public DTO does not disclose solution/rubric");
  await api("POST", `/tests/${view.id}/start`, {
    expectedRevision: view.revision,
    operationId: randomUUID(),
  });
  view = await testView(view.id);
  const questionId = view.questionIds[0],
    revealed = await api("POST", `/tests/${view.id}/reveal`, {
      questionId,
      expectedRevision: view.revision,
      operationId: randomUUID(),
    });
  assert(
    revealed.solution.citations.every((c: any) => c.sourcePath.length >= 3),
  );
  report.question = view.questions[0].promptMarkdown;
  report.checks.push(
    "Fixed full source hierarchy is available after explicit reveal",
  );
  view = await testView(view.id);
  const answerText =
    revealed.solution.candidate.solution.steps
      .map((s: any) => s.explanationMarkdown)
      .join("\n\n") +
    "\n\n" +
    revealed.solution.candidate.solution.finalAnswerMarkdown;
  const draft = {
    text: answerText,
    expectedDraftRevision: 0,
    operationId: randomUUID(),
  };
  await api("PUT", `/tests/${view.id}/drafts/${questionId}`, draft);
  const attemptBody = {
    questionId,
    sittingId: view.currentSittingId,
    answerText,
    paper: false,
    expectedRevision: view.revision,
    operationId: randomUUID(),
  };
  const submitted = await api(
    "POST",
    `/tests/${view.id}/attempts`,
    attemptBody,
    202,
  );
  assert.deepEqual(
    await api("POST", `/tests/${view.id}/attempts`, attemptBody, 202),
    submitted,
  );
  view = await waitFor((v) => v.attempts[0]?.assessment !== null, "grade");
  assert.equal(view.state, "completed");
  assert.equal(view.attempts.length, 1);
  assert(view.attempts[0].assistanceUsed);
  report.grade = {
    state: view.attempts[0].assessmentState,
    score: view.score,
    maxScore: view.maxScore,
    source: view.attempts[0].assessment?.gradeSource,
  };
  report.checks.push(
    "Cloud Run real-model grading, natural completion and idempotent attempt replay succeeded",
  );
  const evidence = await collection("learning_states")
    .doc("subspace-test")
    .collection("evidence")
    .where("testId", "==", view.id)
    .get();
  assert(evidence.docs.every((d) => d.data().valid === false));
  report.checks.push(
    "Verification test contributes no valid learning evidence",
  );
  report.completedAt = new Date().toISOString();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : "failed";
  throw error;
} finally {
  const output = resolve("data/math-cloud-verification");
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: report.passed,
      testId: report.testId,
      checks: report.checks,
      grade: report.grade,
      report: `${output}/report.json`,
    }),
  );
  await app.close();
  await mathDb.terminate();
}
