import { db } from "./firestore.js";
import {
  FieldPath,
  type DocumentReference,
  type Transaction,
} from "@google-cloud/firestore";
import type {
  Catalog,
  ScopePreview,
  MathTest,
  TestView,
  Scope,
  PublicQuestion,
  Attempt,
  Draft,
  Sitting,
} from "./math-types.js";
import {
  checkBytes,
  contentHash,
  invariant,
  MATH_LIMITS,
  MathError,
} from "./math-schema.js";
export { db as mathDb };
export const collection = (name: string) => db.collection(`math_${name}`);
export function bounded<T>(value: T): T {
  checkBytes(value, MATH_LIMITS.documentBytes);
  return value;
}
export async function readDoc<T>(
  ref: DocumentReference,
  tx?: Transaction,
): Promise<T | null> {
  const doc = tx ? await tx.get(ref) : await ref.get();
  return doc.exists ? (doc.data() as T) : null;
}
export async function requiredDoc<T>(
  ref: DocumentReference,
  tx?: Transaction,
): Promise<T> {
  const value = await readDoc<T>(ref, tx);
  invariant(value, "MATH_NOT_FOUND", 404);
  return value;
}
export function chunkValue(value: unknown): string[] {
  const text = JSON.stringify(value);
  const chunks: string[] = [];
  function split(s: string) {
    if (
      Buffer.byteLength(JSON.stringify({ data: s })) <= MATH_LIMITS.chunkBytes
    )
      chunks.push(s);
    else {
      const at = Math.floor(s.length / 2);
      split(s.slice(0, at));
      split(s.slice(at));
    }
  }
  split(text);
  return chunks;
}
export async function writeChunks(
  ref: DocumentReference,
  name: string,
  value: unknown,
) {
  const chunks = chunkValue(value);
  for (let i = 0; i < chunks.length; i++)
    await ref
      .collection(name)
      .doc(String(i).padStart(5, "0"))
      .set({ data: chunks[i], hash: contentHash(chunks[i]) });
  return { count: chunks.length, hash: contentHash(value) };
}
export async function readChunks<T>(
  ref: DocumentReference,
  name: string,
  expected?: { count: number; hash: string },
): Promise<T> {
  const docs = await ref.collection(name).orderBy(FieldPath.documentId()).get();
  invariant(
    !expected || docs.size === expected.count,
    "MATH_CHUNKS_INCOMPLETE",
    503,
  );
  const text = docs.docs
    .map((d) => {
      const v = d.data();
      invariant(contentHash(v.data) === v.hash, "MATH_CHUNK_CORRUPT", 503);
      return v.data;
    })
    .join("");
  const value = JSON.parse(text);
  invariant(
    !expected || contentHash(value) === expected.hash,
    "MATH_CHUNK_CORRUPT",
    503,
  );
  return value;
}
export async function activeCatalogId(): Promise<string | null> {
  const settings = await readDoc<{
    activeCatalogId: string;
    schemaVersion: number;
  }>(collection("settings").doc("main"));
  if (!settings) return null;
  invariant(settings.schemaVersion === 1, "MATH_SCHEMA_UNSUPPORTED", 503);
  return settings.activeCatalogId;
}
export async function publishCatalog(
  catalog: Catalog,
  artifacts: Record<string, string>,
  provenances: Record<string, unknown>,
  expectedActiveCatalogId: string | null,
) {
  invariant(catalog.schemaVersion === 1, "MATH_SCHEMA_UNSUPPORTED", 503);
  const ref = collection("catalogs").doc(catalog.id),
    existing = await readDoc<any>(ref);
  if (!existing)
    await ref.set({
      state: "staging",
      schemaVersion: 1,
      manifestHash: catalog.id,
      parserVersion: catalog.parserVersion,
      createdAt: Date.now(),
      complete: false,
    });
  for (const [name, rows] of Object.entries({
    subjects: catalog.subjects,
    nodes: catalog.nodes,
    units: catalog.units,
    concepts: catalog.concepts,
    objectives: catalog.objectives,
    profiles: catalog.profiles,
  }))
    for (const row of rows) {
      const data = {
        ...row,
        ...(name === "objectives"
          ? {
              subjectId: catalog.units.find((u) => u.id === (row as any).unitId)
                ?.subjectId,
            }
          : {}),
      };
      const target = ref.collection(name).doc(row.id);
      const stored = await readDoc<any>(target);
      if (stored)
        invariant(
          contentHash(stored) === contentHash(data),
          "MATH_IMMUTABLE_CONFLICT",
          409,
        );
      else await target.create(bounded(data));
    }
  for (const unit of catalog.units)
    await immutableSet(collection("unit_revisions").doc(unit.revisionId), unit);
  for (const concept of catalog.concepts)
    await immutableSet(
      collection("concept_revisions").doc(concept.revisionId),
      {
        id: concept.id,
        title: concept.title,
        kind: concept.kind,
        statement: concept.statement,
        conditions: concept.conditions,
        capabilities: concept.capabilities,
        provideable: concept.provideable,
        requiredToUseWhenGiven: concept.requiredToUseWhenGiven,
        schemaVersion: 1,
        parserVersion: catalog.parserVersion,
      },
    );
  for (const [hash, markdown] of Object.entries(artifacts))
    await immutableSet(collection("source_revisions").doc(hash), { markdown });
  for (const [hash, data] of Object.entries(provenances)) {
    if ((data as any)?.sourceRevisionId) {
      const { outline, ...metadata } = data as Record<string, unknown>;
      const sourceRef = collection("source_documents").doc(hash);
      await immutableSet(sourceRef, metadata);
      const outlineRef = sourceRef
        .collection("outlines")
        .doc(contentHash(outline));
      const sourceOutlineChunks = await writeChunks(
        outlineRef,
        "outline_chunks",
        outline,
      );
      await immutableSet(outlineRef, { chunks: sourceOutlineChunks });
      continue;
    }
    const target = collection("provenance_revisions").doc(hash);
    const { review, ...provenance } = data as Record<string, unknown>;
    invariant(
      contentHash(provenance) === hash,
      "MATH_PROVENANCE_HASH_MISMATCH",
    );
    const chunks = await writeChunks(target, "chunks", provenance);
    await immutableSet(target, { chunks });
    if (review)
      await immutableSet(
        target.collection("reviews").doc(contentHash(review)),
        review,
      );
  }
  await writeChunks(
    ref,
    "graph_chunks",
    catalog.concepts.map((c) => ({
      conceptId: c.id,
      capabilities: c.capabilities,
    })),
  );
  const manifest = await writeChunks(ref, "manifest_chunks", catalog);
  const readback = await readChunks<Catalog>(ref, "manifest_chunks", manifest);
  invariant(
    contentHash(readback) === contentHash(catalog),
    "MATH_READBACK_FAILED",
    503,
  );
  for (const name of [
    "subjects",
    "nodes",
    "units",
    "concepts",
    "objectives",
    "profiles",
  ] as const) {
    const snap = await ref.collection(name).get();
    invariant(snap.size === catalog[name].length, "MATH_READBACK_FAILED", 503);
  }
  await ref.set(
    {
      complete: true,
      manifest,
      counts: Object.fromEntries(
        [
          "subjects",
          "nodes",
          "units",
          "concepts",
          "objectives",
          "profiles",
        ].map((k) => [k, (catalog as any)[k].length]),
      ),
    },
    { merge: true },
  );
  await db.runTransaction(async (tx) => {
    const settingsRef = collection("settings").doc("main"),
      current = await readDoc<any>(settingsRef, tx),
      staged = await requiredDoc<any>(ref, tx);
    invariant(
      (current?.activeCatalogId ?? null) === expectedActiveCatalogId,
      "CATALOG_CHANGED",
      409,
    );
    invariant(staged.complete, "MATH_CATALOG_INCOMPLETE", 409);
    tx.set(
      ref,
      { state: "published", publishedAt: Date.now() },
      { merge: true },
    );
    tx.set(settingsRef, { activeCatalogId: catalog.id, schemaVersion: 1 });
  });
  return catalog.id;
}
async function immutableSet(ref: DocumentReference, value: unknown) {
  const current = await readDoc(ref);
  if (current)
    invariant(
      contentHash(current) === contentHash(value),
      "MATH_IMMUTABLE_CONFLICT",
      409,
    );
  else await ref.create(bounded(value as Record<string, unknown>));
}
export async function rollbackCatalog(id: string, expected: string | null) {
  await db.runTransaction(async (tx) => {
    const target = await requiredDoc<any>(collection("catalogs").doc(id), tx),
      settings = await readDoc<any>(collection("settings").doc("main"), tx);
    invariant(
      target.state === "published" && target.complete,
      "MATH_CATALOG_UNPUBLISHED",
      409,
    );
    invariant(
      (settings?.activeCatalogId ?? null) === expected,
      "CATALOG_CHANGED",
      409,
    );
    tx.set(collection("settings").doc("main"), {
      activeCatalogId: id,
      schemaVersion: 1,
    });
  });
}
export async function loadCatalog(
  id: string,
  subjectId?: string,
): Promise<Catalog> {
  const ref = collection("catalogs").doc(id),
    meta = await requiredDoc<any>(ref);
  invariant(meta.schemaVersion === 1, "MATH_SCHEMA_UNSUPPORTED", 503);
  invariant(
    meta.state === "published" && meta.complete,
    "MATH_CATALOG_UNPUBLISHED",
    404,
  );
  const names = [
    "subjects",
    "nodes",
    "units",
    "concepts",
    "objectives",
    "profiles",
  ] as const;
  const rows = await Promise.all(
    names.map(async (name) => {
      let query: FirebaseFirestore.Query = ref.collection(name);
      if (subjectId && !["subjects", "profiles"].includes(name))
        query = query.where("subjectId", "==", subjectId);
      return (await query.get()).docs.map((d) => {
        const data = d.data();
        if (name === "objectives") {
          const { subjectId, ...objective } = data;
          return objective;
        }
        return data;
      });
    }),
  );
  return {
    id,
    schemaVersion: 1,
    parserVersion: meta.parserVersion,
    ...Object.fromEntries(names.map((name, i) => [name, rows[i]])),
  } as Catalog;
}
export async function catalogSummary() {
  const id = await activeCatalogId();
  if (!id) return { activeCatalogId: null, subjects: [] };
  const docs = await collection("catalogs")
    .doc(id)
    .collection("subjects")
    .orderBy("order")
    .get();
  return { activeCatalogId: id, subjects: docs.docs.map((d) => d.data()) };
}
export async function savePreview(preview: ScopePreview) {
  const ref = collection("scope_previews").doc(preview.id);
  const chunks = await writeChunks(ref, "scope_chunks", preview);
  await ref.create({
    catalogId: preview.catalogId,
    scopeHash: preview.scopeHash,
    expiresAt: preview.expiresAt,
    chunks,
  });
}
export async function getPreview(id: string) {
  const ref = collection("scope_previews").doc(id),
    meta = await requiredDoc<any>(ref);
  return readChunks<ScopePreview>(ref, "scope_chunks", meta.chunks);
}
export async function getScope(id: string): Promise<Scope> {
  const ref = collection("tests").doc(id),
    meta = await requiredDoc<any>(ref);
  return readChunks<Scope>(ref, "scope_chunks", meta.scopeChunks);
}
export function publicTest(test: MathTest): MathTest {
  const keys = [
    "purpose",
    "id",
    "schemaVersion",
    "catalogId",
    "scopeHash",
    "config",
    "state",
    "revision",
    "generationJobId",
    "currentSittingId",
    "questionIds",
    "answeredQuestionIds",
    "invalidQuestionIds",
    "revealedQuestionIds",
    "createdAt",
    "updatedAt",
  ] as const;
  return Object.fromEntries(
    keys.map((key) => [key, test[key]]),
  ) as unknown as MathTest;
}
export function publicQuestion(q: PublicQuestion): PublicQuestion {
  return {
    id: q.id,
    ordinal: q.ordinal,
    promptMarkdown: q.promptMarkdown,
    answerFormat: q.answerFormat,
    targetObjectiveIds: q.targetObjectiveIds,
    difficulty: q.difficulty,
    validationStatus: q.validationStatus,
    contentHash: q.contentHash,
  };
}
export async function testView(id: string): Promise<TestView> {
  const ref = collection("tests").doc(id),
    test = await requiredDoc<MathTest>(ref),
    scope = await getScope(id);
  invariant(test.schemaVersion === 1, "MATH_SCHEMA_UNSUPPORTED", 503);
  const [questions, attempts, drafts, sitting] = await Promise.all([
    ref.collection("questions").get(),
    ref.collection("attempts").get(),
    ref.collection("drafts").get(),
    test.currentSittingId
      ? readDoc<Sitting>(ref.collection("sittings").doc(test.currentSittingId))
      : null,
  ]);
  const publicQuestions = questions.docs
    .map((d) => publicQuestion(d.data() as PublicQuestion))
    .filter((q) => test.questionIds.includes(q.id))
    .sort((a, b) => a.ordinal - b.ordinal);
  const savedAttempts = attempts.docs.map((d) => d.data() as Attempt);
  let score = 0,
    maxScore = 0,
    pendingGrades = 0;
  for (const a of savedAttempts) {
    if (test.invalidQuestionIds.includes(a.questionId)) continue;
    if (a.assessment && a.assessmentState === "graded") {
      score += a.assessment.correctnessScore;
      maxScore += a.assessment.criteria.reduce((s, c) => s + c.maxPoints, 0);
    } else pendingGrades++;
  }
  // Graded criteria are immutable per question; ungraded questions still count toward the denominator.
  const solutions = await ref.collection("solutions").get();
  maxScore = solutions.docs
    .filter(
      (d) =>
        test.questionIds.includes(d.id) &&
        !test.invalidQuestionIds.includes(d.id),
    )
    .reduce(
      (s, d) =>
        s +
        (d.data().candidate.rubric as any[]).reduce((n, c) => n + c.points, 0),
      0,
    );
  return {
    ...publicTest(test),
    questions: publicQuestions,
    attempts: savedAttempts,
    drafts: drafts.docs.map((d) => d.data() as Draft),
    sitting,
    score,
    maxScore,
    pendingGrades,
    scopeSummary: {
      targets: scope.targetObjectiveIds.length,
      prerequisites: scope.prerequisites.length,
      baseline: scope.baseline.length,
    },
    coverage: scope.coverage,
  };
}
export async function page(
  query: FirebaseFirestore.Query,
  cursor?: string,
  limit = 50,
) {
  invariant(limit >= 1 && limit <= 100, "MATH_INVALID_LIMIT");
  let q = query.orderBy(FieldPath.documentId());
  if (cursor) q = q.startAfter(cursor);
  const docs = await q.limit(limit + 1).get();
  const data = docs.docs.slice(0, limit);
  return {
    items: data.map((d) => d.data()),
    nextCursor: docs.size > limit ? data.at(-1)!.id : null,
  };
}
export async function globalOperation(
  type: string,
  operationId: string,
  payload: unknown,
  work: (tx: Transaction) => Promise<Record<string, unknown>>,
) {
  const ref = collection("operation_receipts").doc(operationId),
    hash = contentHash({ type, payload });
  return db.runTransaction(async (tx) => {
    const receipt = await readDoc<any>(ref, tx);
    if (receipt) {
      invariant(receipt.requestHash === hash, "MATH_OPERATION_CONFLICT", 409);
      return receipt.result;
    }
    const result = await work(tx);
    tx.create(
      ref,
      bounded({
        operationType: type,
        requestHash: hash,
        result,
        committedAt: Date.now(),
      }),
    );
    return result;
  });
}
