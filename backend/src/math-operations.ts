import { randomUUID } from "node:crypto";
import type {
  MathTest,
  Sitting,
  Attempt,
  StoredSolution,
  Draft,
  MathJob,
  Assessment,
} from "./math-types.js";
import {
  collection,
  mathDb as db,
  readDoc,
  requiredDoc,
  bounded,
  loadCatalog,
} from "./math-store.js";
import {
  contentHash,
  invariant,
  checkBytes,
  MATH_LIMITS,
  PROMPT_VERSION,
} from "./math-schema.js";
import { validateAssessment } from "./math-generation.js";
import { writeLearningEvidence } from "./math-learning.js";
export function newSitting(id: string, now: number): Sitting {
  return {
    id,
    state: "active",
    startedAt: now,
    endedAt: null,
    attemptIds: [],
    review: { state: "idle", revision: 0, cursor: 0, attemptIds: [] },
  };
}
export function completeIfExhausted(
  test: MathTest,
  sitting: Sitting | null,
  now: number,
) {
  if (
    test.questionIds.every(
      (id) =>
        test.answeredQuestionIds.includes(id) ||
        test.invalidQuestionIds.includes(id),
    )
  ) {
    test.state = "completed";
    if (sitting) {
      sitting.state = "ended";
      sitting.endedAt = now;
    }
  }
}
export function makeJob(
  id: string,
  testId: string,
  type: MathJob["type"],
  models: MathJob["frozenConfig"]["models"],
  attemptId: string | null = null,
): MathJob {
  const now = Date.now();
  return {
    id,
    testId,
    type,
    attemptId,
    state: "queued",
    sequence: 0,
    generation: 1,
    cursor: 0,
    stage: type === "grade" ? "grade" : "generate",
    candidateAttempt: 0,
    transportAttempts: 0,
    nextWakeAt: now,
    lease: null,
    frozenConfig: { schemaVersion: 1, promptVersion: PROMPT_VERSION, models },
    calls: 0,
    tokens: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
export type TestAction =
  | "start"
  | "resume"
  | "end-sitting"
  | "review"
  | "draft"
  | "attempts"
  | "skip"
  | "reveal"
  | "cancel"
  | "retry-generation"
  | "accept-partial"
  | "invalidate"
  | "assessment"
  | "retry-grade";
export async function applyTestOperation(
  testId: string,
  action: TestAction,
  body: Record<string, any>,
) {
  const testRef = collection("tests").doc(testId),
    operationRef = testRef.collection("operations").doc(body.operationId),
    hash = contentHash({ action, body });
  const metadata = await requiredDoc<MathTest>(testRef);
  invariant(metadata.schemaVersion === 1, "MATH_SCHEMA_UNSUPPORTED", 503);
  const catalog =
    action === "assessment" || action === "invalidate"
      ? await loadCatalog(metadata.catalogId, metadata.config.subjectId)
      : null;
  const allocated = {
    sittingId: randomUUID(),
    attemptId: randomUUID(),
    jobId: randomUUID(),
  };
  const result = await db.runTransaction(async (tx) => {
    const receipt = await readDoc<any>(operationRef, tx);
    if (receipt) {
      invariant(receipt.requestHash === hash, "MATH_OPERATION_CONFLICT", 409);
      return receipt.result;
    }
    const original = await requiredDoc<MathTest>(testRef, tx),
      test = structuredClone(original),
      now = Date.now();
    const sittingRef = test.currentSittingId
      ? testRef.collection("sittings").doc(test.currentSittingId)
      : null;
    let sitting = sittingRef
      ? await requiredDoc<Sitting>(sittingRef, tx)
      : null;
    const questionId = body.questionId as string | undefined;
    const question = questionId
      ? await readDoc(testRef.collection("questions").doc(questionId), tx)
      : null;
    const solution = questionId
      ? await readDoc<StoredSolution>(
          testRef.collection("solutions").doc(questionId),
          tx,
        )
      : null;
    const draft = questionId
      ? await readDoc<Draft>(testRef.collection("drafts").doc(questionId), tx)
      : null;
    const attempt = body.attemptId
      ? await requiredDoc<Attempt>(
          testRef.collection("attempts").doc(body.attemptId),
          tx,
        )
      : null;
    const attemptSolution = attempt
      ? await requiredDoc<StoredSolution>(
          testRef.collection("solutions").doc(attempt.questionId),
          tx,
        )
      : null;
    const generationJob = await requiredDoc<MathJob>(
      collection("jobs").doc(test.generationJobId),
      tx,
    );
    const attemptJob = attempt?.jobId
      ? await readDoc<MathJob>(collection("jobs").doc(attempt.jobId), tx)
      : null;
    const otherAttempts =
      action === "invalidate"
        ? await tx.get(
            testRef
              .collection("attempts")
              .where("questionId", "==", questionId),
          )
        : null;
    if (
      action !== "draft" &&
      action !== "assessment" &&
      action !== "retry-grade" &&
      action !== "review"
    )
      invariant(
        body.expectedRevision === test.revision,
        "MATH_REVISION_CONFLICT",
        409,
        { currentRevision: test.revision },
      );
    if (questionId)
      invariant(
        question && solution && test.questionIds.includes(questionId),
        "MATH_QUESTION_NOT_FOUND",
        404,
      );
    const output: Record<string, unknown> = { testId, revision: test.revision };
    const active = () =>
      invariant(
        test.state === "in_progress" && sitting?.state === "active",
        "MATH_SITTING_NOT_ACTIVE",
        409,
      );
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
          !sitting || sitting.review.state !== "active",
          "MATH_REVIEW_ACTIVE",
          409,
        );
        sitting = newSitting(allocated.sittingId, now);
        test.currentSittingId = sitting.id;
        test.state = "in_progress";
        break;
      }
      case "draft": {
        active();
        invariant(
          !test.answeredQuestionIds.includes(questionId!),
          "MATH_ALREADY_ANSWERED",
          409,
        );
        checkBytes(body.text, MATH_LIMITS.answerBytes);
        invariant(
          (draft?.revision ?? 0) === body.expectedDraftRevision,
          "MATH_DRAFT_CONFLICT",
          409,
          { currentDraftRevision: draft?.revision ?? 0 },
        );
        const saved: Draft = {
          questionId: questionId!,
          answerText: body.text,
          revision: (draft?.revision ?? 0) + 1,
          savedAt: now,
        };
        tx.set(testRef.collection("drafts").doc(questionId!), bounded(saved));
        output.draft = saved;
        break;
      }
      case "attempts":
      case "skip": {
        active();
        invariant(
          !test.answeredQuestionIds.includes(questionId!),
          "MATH_ALREADY_ANSWERED",
          409,
        );
        if (action === "attempts")
          invariant(
            body.sittingId === sitting!.id,
            "MATH_SITTING_CONFLICT",
            409,
          );
        const answerText = body.answerText ?? "";
        checkBytes(answerText, MATH_LIMITS.answerBytes);
        const skipped = action === "skip",
          paper = !!body.paper;
        invariant(skipped || paper || answerText.trim(), "MATH_EMPTY_ANSWER");
        const assessment: Assessment | null = skipped
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
          : null;
        const saved: Attempt = {
          id: allocated.attemptId,
          questionId: questionId!,
          sittingId: sitting!.id,
          answerText,
          paper,
          skipped,
          assistanceUsed: test.revealedQuestionIds.includes(questionId!),
          assessmentState: skipped
            ? "graded"
            : paper
              ? "needs_review"
              : "submitted",
          gradeVersion: 0,
          assessment,
          history: [],
          submittedAt: now,
        };
        if (!skipped && !paper) {
          saved.jobId = allocated.jobId;
          tx.create(
            collection("jobs").doc(allocated.jobId),
            bounded(
              makeJob(
                allocated.jobId,
                testId,
                "grade",
                generationJob.frozenConfig.models,
                saved.id,
              ),
            ),
          );
          output.jobId = allocated.jobId;
        }
        tx.create(testRef.collection("attempts").doc(saved.id), bounded(saved));
        test.answeredQuestionIds.push(questionId!);
        sitting!.attemptIds.push(saved.id);
        completeIfExhausted(test, sitting, now);
        output.attemptId = saved.id;
        break;
      }
      case "reveal": {
        invariant(
          ["ready", "in_progress", "completed"].includes(test.state),
          "MATH_INVALID_TRANSITION",
          409,
        );
        if (!test.revealedQuestionIds.includes(questionId!))
          test.revealedQuestionIds.push(questionId!);
        output.revealQuestionId = questionId;
        output.hintOnly = !!body.hint;
        break;
      }
      case "end-sitting":
        active();
        sitting!.state = "ended";
        sitting!.endedAt = now;
        break;
      case "review": {
        invariant(sitting?.state === "ended", "MATH_REVIEW_UNAVAILABLE", 409);
        invariant(
          body.reviewRevision === sitting.review.revision,
          "MATH_REVIEW_CONFLICT",
          409,
        );
        if (body.action === "start") {
          invariant(
            sitting.review.state === "idle",
            "MATH_INVALID_TRANSITION",
            409,
          );
          sitting.review = {
            state: sitting.attemptIds.length ? "active" : "completed",
            revision: sitting.review.revision + 1,
            cursor: 0,
            attemptIds: [...sitting.attemptIds],
          };
        } else if (body.action === "next") {
          invariant(
            sitting.review.state === "active",
            "MATH_INVALID_TRANSITION",
            409,
          );
          sitting.review.cursor++;
          sitting.review.revision++;
          if (sitting.review.cursor >= sitting.review.attemptIds.length)
            sitting.review.state = "completed";
        } else {
          invariant(
            sitting.review.state === "active" &&
              sitting.review.cursor >= sitting.review.attemptIds.length - 1,
            "MATH_INVALID_TRANSITION",
            409,
          );
          sitting.review.state = "completed";
          sitting.review.revision++;
        }
        output.review = sitting.review;
        break;
      }
      case "cancel":
        invariant(
          ["generating", "generation_failed", "ready"].includes(test.state),
          "MATH_INVALID_TRANSITION",
          409,
        );
        test.state = "cancelled";
        tx.set(
          collection("jobs").doc(generationJob.id),
          {
            state: "cancelled",
            lease: null,
            sequence: generationJob.sequence + 1,
          },
          { merge: true },
        );
        break;
      case "retry-generation":
        invariant(
          test.state === "generation_failed",
          "MATH_INVALID_TRANSITION",
          409,
        );
        test.state = "generating";
        tx.set(
          collection("jobs").doc(generationJob.id),
          {
            state: "queued",
            lease: null,
            sequence: generationJob.sequence + 1,
            generation: generationJob.generation + 1,
            candidateAttempt: 0,
            transportAttempts: 0,
            lastError: null,
            nextWakeAt: now,
            stage: "generate",
          },
          { merge: true },
        );
        output.jobId = generationJob.id;
        break;
      case "accept-partial":
        invariant(
          test.state === "generation_failed" &&
            body.acceptedQuestionIds.length > 0 &&
            body.acceptedQuestionIds.every((id: string) =>
              test.questionIds.includes(id),
            ) &&
            new Set(body.acceptedQuestionIds).size ===
              body.acceptedQuestionIds.length,
          "MATH_INVALID_PARTIAL",
          409,
        );
        test.questionIds = [...body.acceptedQuestionIds];
        test.state = "ready";
        break;
      case "invalidate": {
        invariant(
          !test.invalidQuestionIds.includes(questionId!),
          "MATH_ALREADY_INVALID",
          409,
        );
        test.invalidQuestionIds.push(questionId!);
        completeIfExhausted(test, sitting, now);
        for (const doc of otherAttempts?.docs ?? []) {
          const a = doc.data() as Attempt;
          if (catalog) writeLearningEvidence(tx, test, a, catalog);
        }
        break;
      }
      case "assessment": {
        invariant(
          attempt &&
            attemptSolution &&
            (attempt.assessmentState === "graded" ||
              attempt.assessmentState === "needs_review" ||
              attempt.assessmentState === "grading_failed"),
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
            new Set(body.criterionScores.map((x: any) => x.criterionId))
              .size === rubric.length,
          "MATH_INVALID_GRADE",
        );
        const assessment = validateAssessment(
          {
            state: "graded",
            criteria: body.criterionScores.map((s: any) => {
              const r = rubric.find((r) => r.criterionId === s.criterionId);
              invariant(r, "MATH_INVALID_GRADE");
              return {
                criterionId: r.criterionId,
                awardedPoints: s.points,
                maxPoints: r.points,
                feedback: body.reason,
                evidenceRanges: [],
                citationIds: [],
              };
            }),
            outsideMethodUsed: false,
            objectiveEvidence: [],
            correctnessScore: body.criterionScores.reduce(
              (s: number, c: any) => s + c.points,
              0,
            ),
            gradeSource: attempt.paper ? "self" : "override",
            feedback: body.reason,
          },
          attempt,
          attemptSolution,
        );
        if (attempt.assessment) attempt.history.push(attempt.assessment);
        attempt.assessment = assessment;
        attempt.assessmentState = "graded";
        attempt.gradeVersion++;
        tx.set(
          testRef.collection("attempts").doc(attempt.id),
          bounded(attempt),
        );
        output.gradeVersion = attempt.gradeVersion;
        if (catalog) writeLearningEvidence(tx, test, attempt, catalog);
        break;
      }
      case "retry-grade": {
        invariant(
          attempt &&
            attemptJob &&
            attempt.assessmentState === "grading_failed" &&
            attemptJob.state === "failed",
          "MATH_INVALID_TRANSITION",
          409,
        );
        invariant(
          body.expectedGradeVersion === attempt.gradeVersion,
          "MATH_GRADE_CONFLICT",
          409,
        );
        attempt.assessmentState = "submitted";
        tx.set(
          testRef.collection("attempts").doc(attempt.id),
          bounded(attempt),
        );
        tx.set(
          collection("jobs").doc(attemptJob.id),
          {
            state: "queued",
            sequence: attemptJob.sequence + 1,
            generation: attemptJob.generation + 1,
            transportAttempts: 0,
            nextWakeAt: now,
            lease: null,
            lastError: null,
          },
          { merge: true },
        );
        output.jobId = attemptJob.id;
        break;
      }
    }
    if (sitting)
      tx.set(testRef.collection("sittings").doc(sitting.id), bounded(sitting));
    if (!["draft", "assessment", "retry-grade", "review"].includes(action)) {
      test.revision++;
      test.updatedAt = now;
      output.revision = test.revision;
      tx.set(testRef, bounded(test));
    }
    tx.create(
      operationRef,
      bounded({ requestHash: hash, result: output, committedAt: now }),
    );
    return output;
  });
  if (result.revealQuestionId) {
    const solution = await requiredDoc<StoredSolution>(
      testRef.collection("solutions").doc(result.revealQuestionId as string),
    );
    return result.hintOnly
      ? {
          ...result,
          hintMarkdown: solution.candidate.solution.strategyMarkdown,
        }
      : { ...result, solution };
  }
  return result;
}
