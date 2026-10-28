import { randomUUID } from "node:crypto";
import type {
  MathJob,
  MathTest,
  Attempt,
  Candidate,
  StoredSolution,
  PublicQuestion,
  Assessment,
  QuestionPlan,
} from "./math-types.js";
import {
  collection,
  mathDb as db,
  requiredDoc,
  readDoc,
  bounded,
  loadCatalog,
  getScope,
} from "./math-store.js";
import {
  invariant,
  contentHash,
  MathError,
  MATH_LIMITS,
  PROMPT_VERSION,
  jsonSchema,
} from "./math-schema.js";
import {
  generateCandidate,
  solveIndependently,
  compareSolutions,
  gradeAttempt,
  contextPack,
  type MathLLM,
} from "./math-generation.js";
import { callLLM, recordUsage } from "./llm.js";
import { enqueueMathJob, localMathJobs } from "./math-task-dispatch.js";
import { withLLMBudget } from "./llm-budget.js";
import { aggregateAssessment } from "./math-v2-operations.js";
import { writeLearningEvidence } from "./math-learning.js";
export interface MathTaskPayload {
  jobId: string;
  generation: number;
  sequence: number;
}
export const MATH_LEASE_MS = 660_000;
const fingerprint = (prompt: string) =>
  prompt.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const TERMINAL = ["succeeded", "failed", "cancelled"];
export async function claimMathJob(
  payload: MathTaskPayload,
  now = Date.now(),
): Promise<MathJob | null> {
  const ref = collection("jobs").doc(payload.jobId);
  return db.runTransaction(async (tx) => {
    const job = await readDoc<MathJob>(ref, tx);
    if (
      !job ||
      TERMINAL.includes(job.state) ||
      job.generation !== payload.generation ||
      job.sequence !== payload.sequence ||
      job.nextWakeAt > now ||
      (job.lease && job.lease.expiresAt > now)
    )
      return null;
    const claimed: MathJob = {
      ...job,
      state: "running",
      lease: { token: randomUUID(), expiresAt: now + MATH_LEASE_MS },
      updatedAt: now,
    };
    if (job.type === "generate" && job.generationEpoch !== undefined) {
      const testRef = collection("tests").doc(job.testId);
      const test = await requiredDoc<MathTest>(testRef, tx);
      if (
        test.generationEpoch !== job.generationEpoch ||
        ["completed", "cancelled"].includes(test.state) ||
        test.pendingGenerationJobId !== job.id
      )
        return null;
      tx.update(testRef, { generationState: "running" });
    }
    tx.set(ref, bounded(claimed));
    return claimed;
  });
}
function holds(current: MathJob, claimed: MathJob) {
  return (
    current.state === "running" &&
    current.sequence === claimed.sequence &&
    current.generation === claimed.generation &&
    current.lease?.token === claimed.lease?.token &&
    current.lease!.expiresAt > Date.now()
  );
}
async function reserveCall(job: MathJob) {
  await db.runTransaction(async (tx) => {
    const ref = collection("jobs").doc(job.id),
      current = await requiredDoc<MathJob>(ref, tx);
    invariant(holds(current, job), "MATH_STALE_LEASE", 409);
    invariant(
      current.calls < MATH_LIMITS.calls &&
        current.tokens + 28_000 <= MATH_LIMITS.tokens,
      "MATH_JOB_BUDGET",
      429,
    );
    tx.update(ref, {
      calls: current.calls + 1,
      tokens: current.tokens + 28_000,
    });
  });
}
function runtimeLLM(job: MathJob): MathLLM {
  return async (feature, system, input, schema) => {
    await reserveCall(job);
    const raw = await callLLM({
      system,
      user: JSON.stringify(input),
      route: `math/${feature}`,
      tier: "full",
      schema: {
        name: `math_${feature}`,
        strict: true,
        schema: jsonSchema(schema),
      },
      maxOutputTokens: MATH_LIMITS.outputTokens,
      maxInputBytes: MATH_LIMITS.inputBytes + 8000,
      worker: {
        model: job.frozenConfig.models[feature],
        onUsage: async (usage, model) => {
          await recordUsage(usage, model, "math-worker", `math/${feature}`);
          if (usage)
            await db.runTransaction(async (tx) => {
              const ref = collection("jobs").doc(job.id),
                current = await requiredDoc<MathJob>(ref, tx);
              if (holds(current, job))
                tx.update(ref, {
                  tokens: current.tokens - 28_000 + usage.total_tokens,
                });
            });
        },
      },
    });
    try {
      return JSON.parse(raw);
    } catch {
      throw new MathError("MATH_INVALID_MODEL_JSON", 422);
    }
  };
}
export async function runMathTask(
  payload: MathTaskPayload,
  injectedLLM?: MathLLM,
) {
  const job = await claimMathJob(payload);
  if (!job) return;
  try {
    await withLLMBudget(540_000, undefined, async () => {
      invariant(
        job.frozenConfig.schemaVersion === 1 &&
          job.frozenConfig.promptVersion === PROMPT_VERSION,
        "MATH_JOB_VERSION_UNSUPPORTED",
        503,
      );
      const llm = injectedLLM ?? runtimeLLM(job),
        testRef = collection("tests").doc(job.testId);
      let patch: Partial<MathJob> = {},
        checkpoint: Record<string, unknown> | null = null,
        accepted: StoredSolution | null = null,
        grade: Assessment | null = null;
      const checkpointId = `g${job.generation}-${job.cursor}-${job.candidateAttempt}`;
      if (job.type === "generate") {
        const scope = await getScope(job.testId),
          catalog = await loadCatalog(scope.catalogId, scope.request.subjectId),
          plan = job.planId
            ? await requiredDoc<QuestionPlan>(
                testRef.collection("question_plans").doc(job.planId),
              )
            : scope.plans[job.cursor];
        invariant(plan, "MATH_PLAN_MISSING", 422);
        if (job.stage === "generate") {
          const previousQuestions = (
            await (job.planId
              ? testRef
                  .collection("questions")
                  .orderBy("ordinal", "desc")
                  .limit(20)
                  .get()
              : testRef.collection("questions").get())
          ).docs.map((d) => d.data() as PublicQuestion);
          const candidate = await generateCandidate(
            llm,
            catalog,
            scope,
            plan,
            previousQuestions,
          );
          checkpoint = { candidate };
          patch = { stage: "solve" };
        } else {
          const saved = await requiredDoc<{
            candidate: Candidate;
            independent?: unknown;
          }>(
            collection("jobs")
              .doc(job.id)
              .collection("checkpoints")
              .doc(checkpointId),
          );
          if (job.stage === "solve") {
            const independent = await solveIndependently(
              llm,
              catalog,
              scope,
              plan,
              saved.candidate,
            );
            checkpoint = { ...saved, independent };
            patch = { stage: "validate" };
          } else {
            accepted = await compareSolutions(
              llm,
              catalog,
              scope,
              plan,
              saved.candidate,
              saved.independent,
            );
            patch = {
              stage: "generate",
              cursor: job.cursor + 1,
              candidateAttempt: 0,
            };
          }
        }
      } else {
        const attempt = await requiredDoc<Attempt>(
          testRef.collection("attempts").doc(job.attemptId!),
        );
        const solution = await requiredDoc<StoredSolution>(
          testRef.collection("solutions").doc(attempt.questionId),
        );
        const scope = await getScope(job.testId),
          catalog = await loadCatalog(scope.catalogId, scope.request.subjectId),
          question = await requiredDoc<PublicQuestion>(
            testRef.collection("questions").doc(attempt.questionId),
          );
        const plan = question.planId
          ? await requiredDoc<QuestionPlan>(
              testRef.collection("question_plans").doc(question.planId),
            )
          : scope.plans[question.ordinal - 1];
        invariant(plan, "MATH_PLAN_MISSING", 422);
        grade = await gradeAttempt(
          llm,
          attempt,
          solution,
          contextPack(catalog, scope, plan),
        );
        patch = { state: "succeeded" };
      }
      const gradingCatalog = grade
        ? await loadCatalog((await requiredDoc<MathTest>(testRef)).catalogId)
        : null;
      const next = await db.runTransaction(async (tx) => {
        const ref = collection("jobs").doc(job.id),
          current = await requiredDoc<MathJob>(ref, tx),
          test = await requiredDoc<MathTest>(testRef, tx);
        if (!holds(current, job) || test.state === "cancelled") return null;
        if (
          job.type === "generate" &&
          test.schemaVersion === 2 &&
          (test.generationEpoch !== job.generationEpoch ||
            test.pendingGenerationJobId !== job.id ||
            test.state === "completed")
        )
          return null;
        const attempt = job.attemptId
          ? await requiredDoc<Attempt>(
              testRef.collection("attempts").doc(job.attemptId),
              tx,
            )
          : null;
        const gradedQuestion =
          job.attemptId && test.schemaVersion === 2 && attempt
            ? await requiredDoc<PublicQuestion>(
                testRef.collection("questions").doc(attempt.questionId),
                tx,
              )
            : null;
        const existingQuestions = accepted
          ? await tx.get(
              test.schemaVersion === 2
                ? testRef
                    .collection("questions")
                    .orderBy("ordinal", "desc")
                    .limit(20)
                : testRef.collection("questions"),
            )
          : null;
        const changed: MathJob = {
          ...current,
          ...patch,
          state: patch.state ?? "queued",
          lease: null,
          sequence: current.sequence + 1,
          transportAttempts: 0,
          nextWakeAt: Date.now(),
          updatedAt: Date.now(),
        };
        if (checkpoint)
          tx.set(
            ref.collection("checkpoints").doc(checkpointId),
            bounded({ ...checkpoint, contextVersion: PROMPT_VERSION }),
          );
        if (accepted) {
          const scopeCount = test.config.questionCount,
            id = `q-${job.ordinal ?? job.cursor + 1}`;
          const candidate = accepted.candidate,
            hash = contentHash({
              prompt: candidate.promptMarkdown,
              answerFormat: candidate.answerFormat,
            });
          invariant(
            !existingQuestions?.docs.some(
              (d) =>
                d.data().contentHash === hash ||
                (test.schemaVersion === 2 &&
                  fingerprint(d.data().promptMarkdown) ===
                    fingerprint(candidate.promptMarkdown)),
            ),
            "MATH_DUPLICATE_QUESTION",
            422,
          );
          const question: PublicQuestion = {
            id,
            ordinal: job.ordinal ?? job.cursor + 1,
            ...(job.planId
              ? {
                  planId: job.planId,
                  answered: false,
                  revealed: false,
                  invalid: false,
                }
              : {}),
            promptMarkdown: candidate.promptMarkdown,
            answerFormat: candidate.answerFormat,
            targetObjectiveIds: candidate.targetObjectiveIds,
            difficulty: candidate.estimatedDifficulty.level,
            validationStatus: "ai-validated",
            contentHash: hash,
          };
          tx.create(testRef.collection("questions").doc(id), bounded(question));
          tx.create(testRef.collection("solutions").doc(id), bounded(accepted));
          if (test.schemaVersion === 2) {
            test.generatedCount = (test.generatedCount ?? 0) + 1;
            test.currentQuestionId = id;
            test.pendingGenerationJobId = null;
            test.generationState = "idle";
            if (test.state === "generating") test.state = "ready";
            changed.state = "succeeded";
          } else test.questionIds.push(id);
          test.revision++;
          test.updatedAt = Date.now();
          if (test.schemaVersion === 1 && changed.cursor >= scopeCount) {
            test.state = "ready";
            changed.state = "succeeded";
          }
          tx.set(testRef, bounded(test));
        }
        if (grade && attempt) {
          invariant(
            ["submitted", "grading"].includes(attempt.assessmentState),
            "MATH_GRADE_CONFLICT",
            409,
          );
          const before = structuredClone(attempt);
          attempt.assessment = grade;
          attempt.assessmentState = grade.state;
          attempt.gradeVersion++;
          tx.set(
            testRef.collection("attempts").doc(attempt.id),
            bounded(attempt),
          );
          if (test.schemaVersion === 2) {
            if (!gradedQuestion?.invalid)
              aggregateAssessment(test, before, attempt);
            tx.set(testRef, bounded(test));
          }
          if (gradingCatalog)
            writeLearningEvidence(
              tx,
              gradedQuestion?.invalid
                ? { ...test, invalidQuestionIds: [attempt.questionId] }
                : test,
              attempt,
              gradingCatalog,
            );
        }
        tx.set(ref, bounded(changed));
        return changed;
      });
      if (next && !TERMINAL.includes(next.state))
        await enqueueMathJob(next).catch(() => {});
    });
  } catch (error) {
    if (error instanceof MathError && error.code === "MATH_STALE_LEASE") return;
    await db.runTransaction(async (tx) => {
      const ref = collection("jobs").doc(job.id),
        current = await requiredDoc<MathJob>(ref, tx),
        test = await requiredDoc<MathTest>(
          collection("tests").doc(job.testId),
          tx,
        ),
        attempt = job.attemptId
          ? await requiredDoc<Attempt>(
              collection("tests")
                .doc(job.testId)
                .collection("attempts")
                .doc(job.attemptId),
              tx,
            )
          : null;
      if (!holds(current, job)) return;
      if (
        job.type === "generate" &&
        test.schemaVersion === 2 &&
        (test.generationEpoch !== job.generationEpoch ||
          test.state === "completed" ||
          test.pendingGenerationJobId !== job.id)
      )
        return;
      const status = (error as any)?.status,
        transport =
          !(error instanceof MathError) &&
          !(error as any)?.name?.includes("Zod") &&
          (!status || status === 429 || status >= 500);
      const candidateAttempts = current.candidateAttempt + (transport ? 0 : 1),
        transportAttempts = current.transportAttempts + (transport ? 1 : 0);
      const retry =
        (job.type === "generate" &&
          !transport &&
          candidateAttempts < 3 &&
          !(
            error instanceof MathError && [429, 503].includes(error.statusCode)
          )) ||
        (transport && transportAttempts <= 3);
      const next: MathJob = {
        ...current,
        state: retry ? "retry_wait" : "failed",
        stage:
          job.type === "grade"
            ? "grade"
            : transport
              ? current.stage
              : "generate",
        candidateAttempt: candidateAttempts,
        transportAttempts,
        sequence: current.sequence + 1,
        lease: null,
        lastError:
          error instanceof MathError
            ? error.code
            : status === 429
              ? "MATH_LLM_RATE_LIMIT"
              : status === 401 || status === 403
                ? "MATH_MODEL_UNAVAILABLE"
                : "MATH_PROCESSING_FAILED",
        nextWakeAt:
          Date.now() + Math.min(60_000, 1000 * 2 ** transportAttempts),
        updatedAt: Date.now(),
      };
      tx.set(ref, bounded(next));
      if (!retry) {
        if (
          job.type === "generate" &&
          (test.state === "generating" || test.schemaVersion === 2)
        ) {
          if (test.state === "generating") test.state = "generation_failed";
          if (test.schemaVersion === 2) test.generationState = "failed";
          test.revision++;
          test.updatedAt = Date.now();
          tx.set(collection("tests").doc(test.id), bounded(test));
        } else if (attempt) {
          attempt.assessmentState = "grading_failed";
          tx.set(
            collection("tests")
              .doc(test.id)
              .collection("attempts")
              .doc(attempt.id),
            bounded(attempt),
          );
        }
      }
    });
  }
}
export async function reconcileMathJobs(runLocal = false) {
  let checked = 0;
  for (const state of ["queued", "retry_wait", "running"]) {
    const docs = await collection("jobs")
      .where("state", "==", state)
      .where("nextWakeAt", "<=", Date.now())
      .orderBy("nextWakeAt")
      .limit(50)
      .get();
    for (const doc of docs.docs) {
      const job = doc.data() as MathJob;
      if (job.lease && job.lease.expiresAt > Date.now()) continue;
      checked++;
      if (runLocal && localMathJobs())
        await runMathTask({
          jobId: job.id,
          generation: job.generation,
          sequence: job.sequence,
        });
      else {
        const recovered = await db.runTransaction(async (tx) => {
          const current = await requiredDoc<MathJob>(doc.ref, tx);
          if (
            TERMINAL.includes(current.state) ||
            (current.lease && current.lease.expiresAt > Date.now()) ||
            current.nextWakeAt > Date.now()
          )
            return null;
          const recovered = {
            ...current,
            state: "queued" as const,
            lease: null,
            sequence: current.sequence + 1,
            nextWakeAt: Date.now(),
            updatedAt: Date.now(),
          };
          tx.set(doc.ref, bounded(recovered));
          return recovered;
        });
        if (recovered) await enqueueMathJob(recovered).catch(() => {});
      }
    }
  }
  // Bounded cleanup is separate from retained catalogs, revisions, tests and operation receipts.
  const expired = await collection("scope_previews")
    .where("expiresAt", "<", Date.now())
    .limit(20)
    .get();
  for (const doc of expired.docs) await db.recursiveDelete(doc.ref);
  const staging = await collection("catalogs")
    .where("state", "==", "staging")
    .where("createdAt", "<", Date.now() - 7 * 86400_000)
    .limit(5)
    .get();
  for (const doc of staging.docs) await db.recursiveDelete(doc.ref);
  return checked;
}
