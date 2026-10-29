import { randomUUID } from "node:crypto";
import { db } from "./firestore.js";
import { mathHash } from "./math-core.js";
import type { MathBook, MathSource, MathTest } from "./math-types.js";
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
  return doc.data() as MathTest;
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
    const test = doc.data() as MathTest;
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
    const next = prepare(test);
    next.lock = { token, until: Date.now() + 240_000 };
    next.version = test.version + 1;
    next.updatedAt = new Date().toISOString();
    delete next.error;
    tx.set(ref, next, { merge: false });
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
      tx.set(ref, next);
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
