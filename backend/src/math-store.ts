import { randomUUID } from "node:crypto";
import { db } from "./firestore.js";
import type { Transaction, DocumentReference } from "@google-cloud/firestore";
import { mathHash, mathPromptHash, publicMathTest } from "./math-core.js";
import type {
  MathBook,
  MathSource,
  MathTest,
  MathHistoryPage,
  MathHistoryItem,
  Curriculum,
  ObjectiveProgress,
  AssessmentPlan,
} from "./math-types.js";
import { loadMathCurriculum } from "./math-publication.js";
import { selectAssessmentPlan } from "./math-assessment-plan.js";
export class MathError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export const booksCollection = () => db.collection("math_books");
export const testsCollection = () => db.collection("math_tests");
export async function listMathBooks(): Promise<MathBook[]> {
  return (await booksCollection().get()).docs.map((d) => d.data() as MathBook);
}
export async function mathSources(ids: string[]): Promise<MathSource[]> {
  if (!ids.length) return [];
  const docs = await db.getAll(
    ...ids.map((id) => db.collection("math_chapter_versions").doc(id)),
  );
  if (docs.some((d) => !d.exists))
    throw new MathError(409, "MATH_SOURCE_MISSING");
  return docs.map((d) => d.data() as MathSource);
}
export async function getMathTest(id: string): Promise<MathTest> {
  const doc = await testsCollection().doc(id).get();
  if (!doc.exists) throw new MathError(404, "MATH_TEST_NOT_FOUND");
  const test = await hydrateMathTest(doc.data() as MathTest);
  if (test.assessmentVersion === 2) await frozenCurriculum(test);
  return test;
}
export async function createMathTest(
  test: MathTest,
  requestHash: string,
): Promise<MathTest> {
  return db.runTransaction(async (tx) => {
    const ref = testsCollection().doc(test.id);
    const existing = await tx.get(ref);
    if (existing.exists) {
      if (existing.get("requestHash") !== requestHash)
        throw new MathError(409, "MATH_OPERATION_CONFLICT");
      const { requestHash: _hash, ...data } = existing.data()!;
      return data as MathTest;
    }
    tx.create(ref, { ...test, requestHash });
    return test;
  });
}
// Each operation has a durable receipt. A fencing token prevents an expired worker
// from committing after a different request acquired its lease.
export async function runMathOperation(
  id: string,
  version: number,
  operationId: string,
  payload: unknown,
  prepare: (test: MathTest) => MathTest,
  work: (test: MathTest) => Promise<MathTest>,
): Promise<MathTest> {
  const ref = testsCollection().doc(id);
  const receipt = ref.collection("operations").doc(operationId);
  const fingerprint = mathHash(JSON.stringify(payload));
  const token = randomUUID();
  const claim = await db.runTransaction(async (tx) => {
    const [doc, saved] = await Promise.all([tx.get(ref), tx.get(receipt)]);
    if (!doc.exists) throw new MathError(404, "MATH_TEST_NOT_FOUND");
    const test = await hydrateMathTest(doc.data() as MathTest, tx);
    if (saved.exists && saved.get("fingerprint") !== fingerprint)
      throw new MathError(409, "MATH_OPERATION_CONFLICT");
    if (saved.get("done") === true) return { done: true, test };
    if (test.lock && test.lock.until > Date.now())
      throw new MathError(409, "MATH_BUSY");
    // A retry of an interrupted operation can use its original version, but may
    // not overtake a successful intervening mutation.
    if (
      test.version !== version &&
      saved.get("claimedVersion") !== test.version
    )
      throw new MathError(409, "MATH_STALE_VERSION");
    if (test.assessmentVersion === 2) await frozenCurriculum(test);
    const before = structuredClone(test);
    const next = prepare(test);
    await updateEvidence(tx, ref, before, next);
    next.lock = { token, until: Date.now() + 240_000 };
    next.version = test.version + 1;
    next.updatedAt = new Date().toISOString();
    delete next.error;
    delete next.assessmentFailure;
    writeMathTest(tx, ref, next);
    tx.set(receipt, { fingerprint, done: false, claimedVersion: next.version });
    return { done: false, test: next };
  });
  if (claim.done) return claim.test;
  try {
    const next = await work(structuredClone(claim.test));
    if (Buffer.byteLength(JSON.stringify(next)) > 700_000)
      throw new MathError(413, "MATH_TEST_TOO_LARGE");
    return await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (current.get("lock.token") !== token)
        throw new MathError(409, "MATH_STALE_VERSION");
      delete next.lock;
      next.version = claim.test.version + 1;
      next.updatedAt = new Date().toISOString();
      let promptMarker: DocumentReference | undefined;
      if (
        next.mode === "continuous" &&
        next.currentQuestionId !== claim.test.currentQuestionId
      ) {
        const q = next.questions[0];
        const marker = ref.collection("prompts").doc(mathPromptHash(q.prompt));
        if ((await tx.get(marker)).exists)
          throw new MathError(409, "MATH_DUPLICATE_QUESTION");
        promptMarker = marker;
      }
      await updateEvidence(tx, ref, claim.test, next);
      if (promptMarker)
        tx.create(promptMarker, { questionId: next.currentQuestionId });
      writeMathTest(tx, ref, next);
      tx.set(receipt, { fingerprint, done: true });
      return next;
    });
  } catch (err) {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (doc.get("lock.token") !== token) return;
      const failed = doc.data() as MathTest;
      delete failed.lock;
      if (failed.status === "generating") failed.status = "generation_failed";
      failed.error = "MATH_OPERATION_FAILED";
      const diagnostics = (
        err as { assessmentDiagnostics?: MathTest["assessmentFailure"] }
      )?.assessmentDiagnostics;
      if (diagnostics && Buffer.byteLength(JSON.stringify(diagnostics)) < 25000)
        failed.assessmentFailure = diagnostics;
      failed.version++;
      failed.updatedAt = new Date().toISOString();
      tx.set(ref, failed);
      tx.set(receipt, {
        fingerprint,
        done: false,
        claimedVersion: failed.version,
      });
    });
    throw err;
  }
}

// Continuous parents stay bounded: only the current question is hydrated in memory.
async function hydrateMathTest(
  test: MathTest,
  tx?: Transaction,
): Promise<MathTest> {
  if (test.mode !== "continuous" || !test.currentQuestionId) return test;
  const ref = testsCollection()
    .doc(test.id)
    .collection("questions")
    .doc(test.currentQuestionId);
  const doc = tx ? await tx.get(ref) : await ref.get();
  if (!doc.exists) throw new MathError(409, "MATH_QUESTION_MISSING");
  const data = doc.data()!;
  return {
    ...test,
    questions: [data.question],
    answers: data.answer ? { [data.question.id]: data.answer } : {},
  };
}
function writeMathTest(
  tx: Transaction,
  ref: DocumentReference,
  test: MathTest,
): void {
  if (test.mode !== "continuous") {
    tx.set(ref, test);
    return;
  }
  const q = test.questions.find((q) => q.id === test.currentQuestionId);
  if (q)
    tx.set(ref.collection("questions").doc(q.id), {
      question: q,
      answer: test.answers[q.id] ?? null,
      number: q.number,
    });
  tx.set(ref, { ...test, questions: [], answers: {} });
}
export async function mathQuestionHistory(
  test: MathTest,
  after: number,
): Promise<MathHistoryPage> {
  if (test.mode !== "continuous") {
    const visible = publicMathTest(test);
    const items = visible.questions
      .map((q, i) => ({
        question: q,
        answer: visible.answers[q.id],
        number: i + 1,
      }))
      .filter((q) => q.number > after);
    return {
      items: items.slice(0, 20),
      nextCursor: items.length > 20 ? items[19].number : null,
    };
  }
  const snapshot = await testsCollection()
    .doc(test.id)
    .collection("questions")
    .orderBy("number")
    .startAfter(after)
    .limit(21)
    .get();
  const items: MathHistoryItem[] = snapshot.docs.slice(0, 20).map((doc) => {
    const data = doc.data();
    const visible = publicMathTest({
      ...test,
      questions: [data.question],
      answers: data.answer ? { [data.question.id]: data.answer } : {},
    });
    const question = visible.questions[0];
    return {
      question,
      ...(data.answer ? { answer: visible.answers[data.question.id] } : {}),
      number: data.number,
    };
  });
  return {
    items,
    nextCursor:
      snapshot.docs.length > 20 ? items[items.length - 1].number : null,
  };
}
export async function recentMathPrompts(id: string): Promise<string[]> {
  const snapshot = await testsCollection()
    .doc(id)
    .collection("questions")
    .orderBy("number", "desc")
    .limit(20)
    .get();
  return snapshot.docs.map((doc) =>
    (doc.get("question.prompt") as string).slice(0, 1000),
  );
}
export async function duplicateMathPrompt(
  id: string,
  prompt: string,
): Promise<boolean> {
  return (
    await testsCollection()
      .doc(id)
      .collection("prompts")
      .doc(mathPromptHash(prompt))
      .get()
  ).exists;
}

export async function frozenCurriculum(test: MathTest): Promise<Curriculum> {
  if (
    test.publicationId !== test.book.publicationId ||
    test.curriculumRevision !== test.book.curriculumRevision
  )
    throw new MathError(409, "MATH_CURRICULUM_MISSING");
  return loadMathCurriculum(db, test.book);
}
function evidenceCollection(test: MathTest) {
  return db
    .collection("math_learning_evidence")
    .doc(test.evidenceNamespace ?? test.book.id)
    .collection("objectives");
}
export async function ensureAssessmentPlans(
  test: MathTest,
  excluded: string[] = [],
): Promise<AssessmentPlan[]> {
  if (test.pendingPlans?.length && !excluded.length) return test.pendingPlans;
  const curriculum = await frozenCurriculum(test);
  const snapshot = await evidenceCollection(test).get();
  const evidence = snapshot.docs.map((d) => d.data() as ObjectiveProgress);
  const count = test.mode === "continuous" ? 1 : test.count;
  const plans: AssessmentPlan[] = [];
  for (let i = 0; i < count; i++) {
    const seed = `${test.id}:${(test.generatedCount ?? 0) + i}:${test.lock!.token}`;
    const plan = selectAssessmentPlan(
      { ...test, generatedCount: (test.generatedCount ?? 0) + i },
      curriculum,
      evidence,
      seed,
      excluded,
    );
    if (excluded.length)
      plan.reason =
        "INFEASIBLE_PLAN: previous objective could not satisfy the unchanged task contract";
    plans.push(plan);
    // Reserve exposure in memory so a fixed batch also balances its own chapters.
    const prior = evidence.find(
      (e) => e.objectiveId === plan.primaryObjectiveId,
    );
    if (prior) {
      prior.presented++;
      prior.lastTestId = test.id;
      prior.lastNumber = (test.generatedCount ?? 0) + i + 1;
    } else
      evidence.push({
        schemaVersion: 2,
        objectiveId: plan.primaryObjectiveId,
        presented: 1,
        submitted: 0,
        correct: 0,
        partial: 0,
        incorrect: 0,
        skipped: 0,
        lastTestId: test.id,
        lastNumber: (test.generatedCount ?? 0) + i + 1,
        assistanceStatus: "unknown",
      });
  }
  const ref = testsCollection().doc(test.id);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.get("lock.token") !== test.lock?.token)
      throw new MathError(409, "MATH_STALE_VERSION");
    tx.update(ref, { pendingPlans: plans });
    tx.set(
      ref
        .collection("plans")
        .doc(
          `${test.generatedCount ?? 0}_${excluded.length ? "replacement" : "initial"}`,
        ),
      { plans, excluded },
    );
  });
  test.pendingPlans = plans;
  return plans;
}
async function updateEvidence(
  tx: Transaction,
  ref: DocumentReference,
  before: MathTest,
  after: MathTest,
): Promise<void> {
  if (after.assessmentVersion !== 2) return;
  const changes: {
    q: MathTest["questions"][number];
    event: "presented" | "skipped" | "graded" | "assistance";
  }[] = [];
  for (const q of after.questions) {
    if (!q.primaryObjectiveId) continue;
    const old = before.questions.find((p) => p.id === q.id),
      answer = after.answers[q.id],
      prior = before.answers[q.id];
    if (!old) changes.push({ q, event: "presented" });
    if (answer?.submitted === false && prior?.submitted !== false)
      changes.push({ q, event: "skipped" });
    if (answer?.grade && !prior?.grade) changes.push({ q, event: "graded" });
    if (q.assistanceStatus === "viewed" && old?.assistanceStatus !== "viewed")
      changes.push({ q, event: "assistance" });
  }
  // Read every affected document before writing any, including multi-question fixed tests.
  const ids = [...new Set(changes.map((c) => c.q.primaryObjectiveId!))];
  const rows = await Promise.all(
    ids.map(async (id) => {
      const local = ref.collection("objectiveProgress").doc(id),
        shared = evidenceCollection(after).doc(id);
      const [a, b] = await Promise.all([tx.get(local), tx.get(shared)]);
      return {
        id,
        local,
        shared,
        a: a.data() as ObjectiveProgress | undefined,
        b: b.data() as ObjectiveProgress | undefined,
      };
    }),
  );
  for (const row of rows) {
    for (const [target, previous] of [
      [row.local, row.a],
      [row.shared, row.b],
    ] as const) {
      const e: ObjectiveProgress = previous ?? {
        schemaVersion: 2,
        objectiveId: row.id,
        presented: 0,
        submitted: 0,
        correct: 0,
        partial: 0,
        incorrect: 0,
        skipped: 0,
        assistanceStatus: "unknown",
      };
      for (const { q, event } of changes.filter(
        (c) => c.q.primaryObjectiveId === row.id,
      )) {
        if (event === "presented") {
          e.presented++;
          e.lastPresentedAt = new Date().toISOString();
          e.lastQuestionId = q.id;
          e.lastTestId = after.id;
          e.lastNumber = q.number ?? after.questions.indexOf(q) + 1;
          e.assistanceStatus = q.assistanceStatus ?? "unknown";
        }
        if (event === "skipped") e.skipped++;
        if (event === "graded") {
          const g = after.answers[q.id].grade!;
          e.submitted++;
          e[g.verdict]++;
          e.lastVerdict = g.verdict;
          e.lastGradedAt = new Date().toISOString();
          e.assistanceStatus = q.assistanceStatus ?? "unknown";
        }
        if (event === "assistance") e.assistanceStatus = "viewed";
      }
      tx.set(target, e);
    }
  }
}
export async function mathObjectiveProgress(
  test: MathTest,
): Promise<ObjectiveProgress[]> {
  return (
    await testsCollection().doc(test.id).collection("objectiveProgress").get()
  ).docs.map((d) => d.data() as ObjectiveProgress);
}
