import { randomUUID } from "node:crypto";
import type {
  MathTest,
  MathJob,
  Sitting,
  Attempt,
  Draft,
  StoredSolution,
  PublicQuestion,
  Scope,
} from "./math-types.js";
import {
  collection,
  mathDb as db,
  readDoc,
  requiredDoc,
  bounded,
  getScope,
  loadCatalog,
} from "./math-store.js";
import {
  contentHash,
  invariant,
  checkBytes,
  MATH_LIMITS,
} from "./math-schema.js";
import { makeJob, type TestAction } from "./math-operations.js";
import { planNextQuestion } from "./math-scope.js";
import { writeLearningEvidence } from "./math-learning.js";
import { validateAssessment } from "./math-generation.js";
const terminal = (t: MathTest) => ["completed", "cancelled"].includes(t.state);
export function aggregateAssessment(
  test: MathTest,
  before: Attempt | null,
  after: Attempt | null,
  invalid = false,
) {
  const value = (a: Attempt | null) =>
    !a
      ? { score: 0, max: 0, pending: 0 }
      : a.assessmentState === "graded" && a.assessment
        ? {
            score: a.assessment.correctnessScore,
            max: a.assessment.criteria.reduce((s, c) => s + c.maxPoints, 0),
            pending: 0,
          }
        : { score: 0, max: a.maxPoints ?? 0, pending: 1 };
  const old = value(before),
    next = invalid ? value(null) : value(after);
  test.score = (test.score ?? 0) + next.score - old.score;
  test.maxScore = (test.maxScore ?? 0) + next.max - old.max;
  test.pendingGrades = (test.pendingGrades ?? 0) + next.pending - old.pending;
}
export function v2Sitting(id: string, now: number, sequence: number): Sitting {
  return {
    id,
    state: "active",
    startedAt: now,
    endedAt: null,
    attemptIds: [],
    startSequence: sequence,
    review: { state: "idle", revision: 0, cursor: 0, attemptIds: [] },
  };
}
export function closeV2(test: MathTest, sitting: Sitting | null, now: number) {
  test.state = "completed";
  test.generationState = "idle";
  test.pendingGenerationJobId = null;
  test.generationEpoch = (test.generationEpoch ?? 0) + 1;
  if (sitting) {
    sitting.state = "ended";
    sitting.endedAt = now;
    sitting.endSequence = test.answeredCount ?? 0;
  }
}
export async function applyV2Operation(
  testId: string,
  action: TestAction,
  body: Record<string, any>,
) {
  const ref = collection("tests").doc(testId),
    op = ref.collection("operations").doc(body.operationId),
    hash = contentHash({ action, body });
  // Receipts precede revision/state checks, including after finish and response loss.
  const saved = await readDoc<any>(op);
  if (saved) {
    invariant(saved.requestHash === hash, "MATH_OPERATION_CONFLICT", 409);
    return revealResult(ref, saved.result);
  }
  const scope = action === "next-question" ? await getScope(testId) : null;
  const metadata = await requiredDoc<MathTest>(ref);
  const catalog = scope
    ? await loadCatalog(scope.catalogId, scope.request.subjectId)
    : ["assessment", "invalidate"].includes(action)
      ? await loadCatalog(metadata.catalogId, metadata.config.subjectId)
      : null;
  const result = await db.runTransaction(async (tx) => {
    const receipt = await readDoc<any>(op, tx);
    if (receipt) {
      invariant(receipt.requestHash === hash, "MATH_OPERATION_CONFLICT", 409);
      return receipt.result;
    }
    const test = await requiredDoc<MathTest>(ref, tx),
      now = Date.now();
    invariant(test.schemaVersion === 2, "MATH_SCHEMA_UNSUPPORTED", 503);
    let sitting = test.currentSittingId
      ? await requiredDoc<Sitting>(
          ref.collection("sittings").doc(test.currentSittingId),
          tx,
        )
      : null;
    const qid = body.questionId as string | undefined;
    const question = qid
      ? await requiredDoc<PublicQuestion>(
          ref.collection("questions").doc(qid),
          tx,
        )
      : null;
    const solution = qid
      ? await requiredDoc<StoredSolution>(
          ref.collection("solutions").doc(qid),
          tx,
        )
      : null;
    const draft = qid
      ? await readDoc<Draft>(ref.collection("drafts").doc(qid), tx)
      : null;
    const attempt = body.attemptId
      ? await requiredDoc<Attempt>(
          ref.collection("attempts").doc(body.attemptId),
          tx,
        )
      : null;
    const attemptSolution = attempt
      ? await requiredDoc<StoredSolution>(
          ref.collection("solutions").doc(attempt.questionId),
          tx,
        )
      : null;
    const attemptQuestion = attempt
      ? await requiredDoc<PublicQuestion>(
          ref.collection("questions").doc(attempt.questionId),
          tx,
        )
      : null;
    const job = await requiredDoc<MathJob>(
      collection("jobs").doc(
        test.pendingGenerationJobId ?? test.generationJobId,
      ),
      tx,
    );
    const gradeJob = attempt?.jobId
      ? await readDoc<MathJob>(collection("jobs").doc(attempt.jobId), tx)
      : null;
    const qAttempt =
      action === "invalidate" && qid
        ? await tx.get(
            ref.collection("attempts").where("questionId", "==", qid).limit(1),
          )
        : null;
    const countDocs = scope
      ? await tx.get(ref.collection("objective_counts"))
      : null;
    let reviewAttempt: Attempt | null = null;
    if (action === "review" && sitting) {
      const sequence =
        body.action === "start"
          ? (sitting.startSequence ?? 1)
          : sitting.review.cursor + 1;
      if (sequence <= (sitting.endSequence ?? 0))
        reviewAttempt = await readDoc<Attempt>(
          ref.collection("attempts").doc(attemptId(testId, sequence)),
          tx,
        );
    }
    if (!["draft", "review", "assessment", "retry-grade"].includes(action))
      invariant(
        body.expectedRevision === test.revision,
        "MATH_REVISION_CONFLICT",
        409,
        { currentRevision: test.revision },
      );
    const output: Record<string, any> = {
      testId,
      schemaVersion: 2,
      revision: test.revision,
    };
    const active = () =>
      invariant(
        test.state === "in_progress" && sitting?.state === "active",
        "MATH_SITTING_NOT_ACTIVE",
        409,
      );
    const cancelGeneration = () => {
      test.generationEpoch = (test.generationEpoch ?? 0) + 1;
      test.pendingGenerationJobId = null;
      test.generationState = "idle";
      if (["queued", "running", "retry_wait"].includes(job.state))
        tx.update(collection("jobs").doc(job.id), {
          state: "cancelled",
          lease: null,
          sequence: job.sequence + 1,
        });
    };
    switch (action) {
      case "start":
      case "resume": {
        invariant(
          action === "start"
            ? test.state === "ready"
            : test.state === "in_progress" && sitting?.state === "ended",
          "MATH_INVALID_TRANSITION",
          409,
        );
        invariant(
          sitting?.review.state !== "active",
          "MATH_REVIEW_ACTIVE",
          409,
        );
        sitting = v2Sitting(randomUUID(), now, (test.answeredCount ?? 0) + 1);
        test.currentSittingId = sitting.id;
        test.state = "in_progress";
        break;
      }
      case "next-question": {
        active();
        invariant(!terminal(test), "MATH_TEST_FINISHED", 409);
        if (test.currentQuestionId) {
          output.questionId = test.currentQuestionId;
          break;
        }
        if (
          test.pendingGenerationJobId &&
          ["queued", "running", "retry_wait"].includes(job.state)
        ) {
          output.jobId = job.id;
          break;
        }
        invariant(
          test.generationState !== "failed",
          "MATH_GENERATION_RETRY_REQUIRED",
          409,
        );
        if (
          test.questionLimit !== null &&
          (test.generatedCount ?? 0) - (test.invalidCount ?? 0) >=
            (test.questionLimit ?? 0)
        ) {
          closeV2(test, sitting, now);
          break;
        }
        const ordinal = test.nextOrdinal ?? 1,
          counts = Object.fromEntries(
            (countDocs?.docs ?? []).map((d) => [d.id, d.data().count ?? 0]),
          );
        const plan = planNextQuestion(scope!, catalog!, ordinal, counts),
          id = `${testId}-e${test.generationEpoch ?? 0}-q${ordinal}`;
        const next = {
          ...makeJob(id, testId, "generate", job.frozenConfig.models),
          planId: plan.id,
          ordinal,
          generationEpoch: test.generationEpoch ?? 0,
        };
        tx.create(ref.collection("question_plans").doc(plan.id), bounded(plan));
        tx.create(collection("jobs").doc(id), bounded(next));
        for (const oid of plan.targetObjectiveIds)
          tx.set(ref.collection("objective_counts").doc(oid), {
            count: (counts[oid] ?? 0) + 1,
          });
        test.nextOrdinal = ordinal + 1;
        test.pendingGenerationJobId = id;
        test.generationJobId = id;
        test.generationState = "queued";
        output.jobId = id;
        break;
      }
      case "draft": {
        active();
        invariant(
          qid === test.currentQuestionId &&
            !question?.answered &&
            !question?.invalid,
          "MATH_ALREADY_ANSWERED",
          409,
        );
        invariant(
          (draft?.revision ?? 0) === body.expectedDraftRevision,
          "MATH_DRAFT_CONFLICT",
          409,
        );
        checkBytes(body.text, MATH_LIMITS.answerBytes);
        const saved = {
          questionId: qid!,
          answerText: body.text,
          revision: (draft?.revision ?? 0) + 1,
          savedAt: now,
        };
        tx.set(ref.collection("drafts").doc(qid!), bounded(saved));
        output.draft = saved;
        break;
      }
      case "attempts":
      case "skip": {
        active();
        invariant(
          qid === test.currentQuestionId &&
            !question?.answered &&
            !question?.invalid,
          "MATH_ALREADY_ANSWERED",
          409,
        );
        if (action === "attempts")
          invariant(
            body.sittingId === sitting!.id,
            "MATH_SITTING_CONFLICT",
            409,
          );
        const text = body.answerText ?? "",
          skipped = action === "skip",
          paper = !!body.paper;
        checkBytes(text, MATH_LIMITS.answerBytes);
        invariant(skipped || paper || text.trim(), "MATH_EMPTY_ANSWER");
        const sequence = (test.answeredCount ?? 0) + 1,
          id = attemptId(testId, sequence);
        const saved: Attempt = {
          id,
          maxPoints: solution!.candidate.rubric.reduce(
            (sum, c) => sum + c.points,
            0,
          ),
          sequence,
          planId: question!.planId,
          questionId: qid!,
          sittingId: sitting!.id,
          answerText: text,
          paper,
          skipped,
          assistanceUsed: !!question!.revealed,
          assessmentState: skipped
            ? "graded"
            : paper
              ? "needs_review"
              : "submitted",
          gradeVersion: 0,
          assessment: skipped
            ? {
                state: "graded",
                criteria: solution!.candidate.rubric.map((r) => ({
                  criterionId: r.criterionId,
                  awardedPoints: 0,
                  maxPoints: r.points,
                  feedback: "",
                  evidenceRanges: [],
                  citationIds: [],
                })),
                outsideMethodUsed: false,
                objectiveEvidence: [],
                correctnessScore: 0,
                gradeSource: "self",
                feedback: body.reason ?? "",
              }
            : null,
          history: [],
          submittedAt: now,
        };
        if (!skipped && !paper) {
          const jid = randomUUID();
          saved.jobId = jid;
          tx.create(
            collection("jobs").doc(jid),
            bounded({
              ...makeJob(jid, testId, "grade", job.frozenConfig.models, id),
              planId: question!.planId,
            }),
          );
          output.jobId = jid;
        }
        tx.create(ref.collection("attempts").doc(id), bounded(saved));
        tx.update(ref.collection("questions").doc(qid!), { answered: true });
        test.currentQuestionId = null;
        test.answeredCount = sequence;
        aggregateAssessment(test, null, saved);
        if (
          test.questionLimit !== null &&
          (test.generatedCount ?? 0) - (test.invalidCount ?? 0) >=
            (test.questionLimit ?? 0)
        )
          closeV2(test, sitting, now);
        output.attemptId = id;
        break;
      }
      case "reveal": {
        invariant(
          question &&
            !question.invalid &&
            ["ready", "in_progress", "completed"].includes(test.state),
          "MATH_INVALID_TRANSITION",
          409,
        );
        tx.update(ref.collection("questions").doc(qid!), { revealed: true });
        output.revealQuestionId = qid;
        output.hintOnly = !!body.hint;
        break;
      }
      case "end-sitting":
        active();
        sitting!.state = "ended";
        sitting!.endedAt = now;
        sitting!.endSequence = test.answeredCount ?? 0;
        cancelGeneration();
        break;
      case "finish":
        test.finishedAt = now;
        invariant(!terminal(test), "MATH_TEST_FINISHED", 409);
        cancelGeneration();
        closeV2(test, sitting, now);
        break;
      case "cancel":
        invariant(
          ["generating", "generation_failed", "ready"].includes(test.state),
          "MATH_INVALID_TRANSITION",
          409,
        );
        cancelGeneration();
        test.state = "cancelled";
        break;
      case "retry-generation": {
        invariant(
          !terminal(test) &&
            test.generationState === "failed" &&
            job.state === "failed",
          "MATH_INVALID_TRANSITION",
          409,
        );
        test.generationState = "queued";
        test.pendingGenerationJobId = job.id;
        if (test.state === "generation_failed") test.state = "generating";
        tx.update(collection("jobs").doc(job.id), {
          state: "queued",
          lease: null,
          sequence: job.sequence + 1,
          generation: job.generation + 1,
          candidateAttempt: 0,
          transportAttempts: 0,
          lastError: null,
          nextWakeAt: now,
          stage: "generate",
        });
        output.jobId = job.id;
        break;
      }
      case "review": {
        invariant(sitting?.state === "ended", "MATH_REVIEW_UNAVAILABLE", 409);
        invariant(
          body.reviewRevision === sitting.review.revision,
          "MATH_REVIEW_CONFLICT",
          409,
        );
        if (body.action === "start")
          invariant(
            sitting.review.state === "idle",
            "MATH_INVALID_TRANSITION",
            409,
          );
        else
          invariant(
            sitting.review.state === "active",
            "MATH_INVALID_TRANSITION",
            409,
          );
        if (body.action === "finish")
          invariant(
            sitting.review.cursor >= (sitting.endSequence ?? 0),
            "MATH_INVALID_TRANSITION",
            409,
          );
        const done = !reviewAttempt || body.action === "finish";
        sitting.review = {
          state: done ? "completed" : "active",
          revision: sitting.review.revision + 1,
          cursor: done ? (sitting.endSequence ?? 0) : reviewAttempt!.sequence!,
          attemptIds: reviewAttempt && !done ? [reviewAttempt.id] : [],
          currentAttemptId: done ? null : reviewAttempt!.id,
          startSequence: sitting.startSequence,
          endSequence: sitting.endSequence,
        };
        output.review = sitting.review;
        break;
      }
      case "invalidate": {
        invariant(question && !question.invalid, "MATH_ALREADY_INVALID", 409);
        tx.update(ref.collection("questions").doc(qid!), { invalid: true });
        test.invalidCount = (test.invalidCount ?? 0) + 1;
        // A naturally exhausted finite test needs a replacement. Explicit finish
        // is final; grading and review never perform this transition.
        if (
          test.state === "completed" &&
          test.generationMode === "finite" &&
          !test.finishedAt &&
          (test.generatedCount ?? 0) - test.invalidCount <
            (test.questionLimit ?? 0)
        )
          test.state = "in_progress";
        if (test.currentQuestionId === qid) test.currentQuestionId = null;
        const a = qAttempt?.docs[0]?.data() as Attempt | undefined;
        if (a) {
          aggregateAssessment(test, a, null, true);
          if (catalog)
            writeLearningEvidence(
              tx,
              { ...test, invalidQuestionIds: [qid!] },
              a,
              catalog,
            );
        }
        break;
      }
      case "assessment": {
        invariant(
          attempt &&
            attemptSolution &&
            ["graded", "needs_review", "grading_failed"].includes(
              attempt.assessmentState,
            ),
          "MATH_GRADE_PENDING",
          409,
        );
        invariant(
          body.expectedGradeVersion === attempt.gradeVersion,
          "MATH_GRADE_CONFLICT",
          409,
        );
        const rubric = attemptSolution.candidate.rubric;
        invariant(
          body.criterionScores.length === rubric.length &&
            new Set(body.criterionScores.map((v: any) => v.criterionId))
              .size === rubric.length,
          "MATH_INVALID_GRADE",
        );
        const before = structuredClone(attempt);
        const criteria = body.criterionScores.map((v: any) => {
          const r = rubric.find((r) => r.criterionId === v.criterionId);
          invariant(r, "MATH_INVALID_GRADE");
          return {
            criterionId: r.criterionId,
            awardedPoints: v.points,
            maxPoints: r.points,
            feedback: body.reason,
            evidenceRanges: [],
            citationIds: [],
          };
        });
        attempt.assessment = validateAssessment(
          {
            state: "graded",
            criteria,
            outsideMethodUsed: false,
            objectiveEvidence: [],
            correctnessScore: criteria.reduce(
              (n: number, c: any) => n + c.awardedPoints,
              0,
            ),
            gradeSource: attempt.paper ? "self" : "override",
            feedback: body.reason,
          },
          attempt,
          attemptSolution,
        );
        attempt.assessmentState = "graded";
        attempt.gradeVersion++;
        // Assessment history is independent, so an individual attempt cannot grow without bound.
        if (before.assessment)
          tx.create(
            ref
              .collection("attempts")
              .doc(attempt.id)
              .collection("assessment_history")
              .doc(String(before.gradeVersion)),
            bounded(before.assessment),
          );
        tx.set(ref.collection("attempts").doc(attempt.id), bounded(attempt));
        if (!attemptQuestion?.invalid)
          aggregateAssessment(test, before, attempt);
        if (catalog)
          writeLearningEvidence(
            tx,
            attemptQuestion?.invalid
              ? { ...test, invalidQuestionIds: [attempt.questionId] }
              : test,
            {
              ...attempt,
              history: before.assessment ? [before.assessment] : [],
            },
            catalog,
          );
        output.gradeVersion = attempt.gradeVersion;
        break;
      }
      case "retry-grade": {
        invariant(
          attempt &&
            gradeJob &&
            attempt.assessmentState === "grading_failed" &&
            gradeJob.state === "failed",
          "MATH_INVALID_TRANSITION",
          409,
        );
        invariant(
          body.expectedGradeVersion === attempt.gradeVersion,
          "MATH_GRADE_CONFLICT",
          409,
        );
        attempt.assessmentState = "submitted";
        tx.set(ref.collection("attempts").doc(attempt.id), bounded(attempt));
        tx.update(collection("jobs").doc(gradeJob.id), {
          state: "queued",
          sequence: gradeJob.sequence + 1,
          generation: gradeJob.generation + 1,
          transportAttempts: 0,
          nextWakeAt: now,
          lease: null,
          lastError: null,
        });
        output.jobId = gradeJob.id;
        break;
      }
      default:
        invariant(false, "MATH_V2_OPERATION_UNSUPPORTED", 400);
    }
    if (sitting)
      tx.set(ref.collection("sittings").doc(sitting.id), bounded(sitting));
    if (!["draft", "review", "retry-grade"].includes(action)) {
      if (action !== "assessment") test.revision++;
      test.updatedAt = now;
      output.revision = test.revision;
      tx.set(ref, bounded(test));
    }
    tx.create(
      op,
      bounded({ requestHash: hash, result: output, committedAt: now }),
    );
    return output;
  });
  return revealResult(ref, result);
}
function attemptId(testId: string, sequence: number) {
  return `${testId}-a-${String(sequence).padStart(12, "0")}`;
}
async function revealResult(
  ref: FirebaseFirestore.DocumentReference,
  result: Record<string, any>,
) {
  if (!result.revealQuestionId) return result;
  const solution = await requiredDoc<StoredSolution>(
    ref.collection("solutions").doc(result.revealQuestionId),
  );
  return result.hintOnly
    ? { ...result, hintMarkdown: solution.candidate.solution.strategyMarkdown }
    : { ...result, solution };
}
