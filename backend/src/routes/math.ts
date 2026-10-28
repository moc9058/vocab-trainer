import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FieldPath } from "@google-cloud/firestore";
import {
  installMathValidator,
  idSchema,
  operationIdSchema,
  hashSchema,
  jsonSchema,
  scopeRequestV2Schema,
  invariant,
  MathError,
  contentHash,
} from "../math-schema.js";
import {
  collection,
  mathDb as db,
  activeCatalogId,
  catalogSummary,
  loadCatalog,
  savePreview,
  getPreview,
  getScope,
  writeChunks,
  readDoc,
  requiredDoc,
  testView,
  publicTest,
  publicQuestion,
  page,
  globalOperation,
  bounded,
} from "../math-store.js";
import type {
  FoundationProfile,
  MathTest,
  MathJob,
  Attempt,
} from "../math-types.js";
import {
  resolveScopeV2,
  planNextQuestion,
  makePreview,
  foundationAcceptanceHash,
} from "../math-scope.js";
import {
  applyTestOperation,
  makeJob,
  type TestAction,
} from "../math-operations.js";
import { mathJobsConfigured, enqueueMathJob } from "../math-task-dispatch.js";
import { resolveModel } from "../llm.js";
const anyId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const empty = z.strictObject({});
const op = { operationId: operationIdSchema },
  revision = { ...op, expectedRevision: z.number().int().nonnegative() };
const params = (fields: Record<string, z.ZodType>) =>
  jsonSchema(z.strictObject(fields));
export const mathRoutes: FastifyPluginAsync = async (app) => {
  installMathValidator(app);
  app.get("/health", async () => ({
    schemaVersion: 2,
    sourceFormats: ["textbook-json", "legacy-markdown"],
    sourceAliasVersion: 2,
  }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MathError)
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          messageKey: "mathError",
          retryable: error.statusCode >= 500,
          details: error.details,
        },
      });
    if (error instanceof z.ZodError || (error as any).validation)
      return reply.code(400).send({
        error: {
          code: "MATH_INVALID_REQUEST",
          messageKey: "mathInvalidRequest",
          retryable: false,
          details: {},
        },
      });
    request.log.error({ err: error }, "Math request failed");
    return reply.code(500).send({
      error: {
        code: "MATH_SERVER_ERROR",
        messageKey: "mathError",
        retryable: true,
        details: {},
      },
    });
  });
  app.get("/catalog", async () => ({
    ...(await catalogSummary()),
    capabilities: {
      browse: true,
      generate: mathJobsConfigured(),
      authoring: "local-cli",
      sharedLearner: true,
    },
  }));
  app.get<{
    Params: { id: string };
    Querystring: {
      subjectId: string;
      parentId?: string;
      cursor?: string;
      limit?: number;
    };
  }>(
    "/catalogs/:id/nodes",
    {
      schema: {
        params: params({ id: hashSchema }),
        querystring: jsonSchema(
          z.strictObject({
            subjectId: idSchema,
            parentId: idSchema.optional(),
            cursor: idSchema.optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
        ),
      },
    },
    async (r) => {
      await loadCatalog(r.params.id, r.query.subjectId);
      let query: FirebaseFirestore.Query = collection("catalogs")
        .doc(r.params.id)
        .collection("nodes")
        .where("subjectId", "==", r.query.subjectId);
      if (r.query.parentId)
        query = query.where("parentId", "==", r.query.parentId);
      return page(query, r.query.cursor, r.query.limit);
    },
  );
  for (const kind of ["units", "concepts"] as const)
    app.get<{ Params: { id: string; itemId: string } }>(
      `/catalogs/:id/${kind}/:itemId`,
      { schema: { params: params({ id: hashSchema, itemId: idSchema }) } },
      async (r) => {
        await loadCatalog(r.params.id);
        return requiredDoc(
          collection("catalogs")
            .doc(r.params.id)
            .collection(kind)
            .doc(r.params.itemId),
        );
      },
    );
  app.get<{ Querystring: { catalogId: string } }>(
    "/foundation-profiles",
    {
      schema: {
        querystring: jsonSchema(z.strictObject({ catalogId: hashSchema })),
      },
    },
    async (r) => {
      const catalog = await loadCatalog(r.query.catalogId);
      return {
        profiles: await Promise.all(
          catalog.profiles.map(async (p) => ({
            ...p,
            capabilitiesHash: foundationAcceptanceHash(catalog, p),
            acceptance: await readDoc(
              collection("foundation_acceptances").doc(p.id),
            ),
          })),
        ),
      };
    },
  );
  const acceptanceSchema = z.strictObject({
    ...op,
    catalogId: hashSchema,
    revision: z.string().min(1).max(100),
    hash: hashSchema,
    accepted: z.boolean(),
  });
  app.put<{ Params: { profileId: string } }>(
    "/foundation-acceptances/:profileId",
    {
      schema: {
        params: params({ profileId: idSchema }),
        body: jsonSchema(acceptanceSchema),
      },
    },
    async (r) => {
      const body = acceptanceSchema.parse(r.body),
        catalog = await loadCatalog(body.catalogId),
        profile = catalog.profiles.find((p) => p.id === r.params.profileId);
      invariant(profile, "MATH_PROFILE_NOT_FOUND", 404);
      invariant(
        profile.revision === body.revision &&
          foundationAcceptanceHash(catalog, profile) === body.hash,
        "MATH_PROFILE_CHANGED",
        409,
      );
      return globalOperation(
        "foundation",
        body.operationId,
        { ...body, profileId: profile.id },
        async (tx) => {
          const ref = collection("foundation_acceptances").doc(profile.id);
          await tx.get(ref);
          tx.set(ref, {
            profileRevision: profile.revision,
            acceptedCapabilitiesHash: body.accepted ? body.hash : null,
            acceptedAt: Date.now(),
          });
          return { profileId: profile.id, accepted: body.accepted };
        },
      );
    },
  );
  const readinessSchema = z.strictObject({
    ...revision,
    catalogId: hashSchema,
    readiness: z.enum(["known", "needs-review", "unknown"]),
  });
  app.get<{
    Params: { conceptId: string };
    Querystring: { cursor?: string; limit?: number };
  }>(
    "/learning-states/:conceptId",
    {
      schema: {
        params: params({ conceptId: idSchema }),
        querystring: jsonSchema(
          z.strictObject({
            cursor: anyId.optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
        ),
      },
    },
    async (r) => ({
      state: await readDoc(
        collection("learning_states").doc(r.params.conceptId),
      ),
      ...(await page(
        collection("learning_states")
          .doc(r.params.conceptId)
          .collection("evidence"),
        r.query.cursor,
        r.query.limit,
      )),
    }),
  );
  app.put<{ Params: { conceptId: string } }>(
    "/learning-states/:conceptId",
    {
      schema: {
        params: params({ conceptId: idSchema }),
        body: jsonSchema(readinessSchema),
      },
    },
    async (r) => {
      const body = readinessSchema.parse(r.body);
      const catalog = await loadCatalog(body.catalogId);
      invariant(
        catalog.concepts.some((c) => c.id === r.params.conceptId),
        "MATH_CONCEPT_NOT_FOUND",
        404,
      );
      return globalOperation(
        "readiness",
        body.operationId,
        { ...body, conceptId: r.params.conceptId },
        async (tx) => {
          const ref = collection("learning_states").doc(r.params.conceptId),
            current = await readDoc<any>(ref, tx);
          invariant(
            (current?.revision ?? 0) === body.expectedRevision,
            "MATH_REVISION_CONFLICT",
            409,
          );
          const value = {
            selfDeclaredReadiness: body.readiness,
            revision: body.expectedRevision + 1,
            updatedAt: Date.now(),
          };
          tx.set(ref, value, { merge: true });
          return value;
        },
      );
    },
  );
  app.post("/scope-previews", async (r) => {
    invariant(
      (r.body as any)?.schemaVersion === 2,
      "MATH_V1_CREATION_UNSUPPORTED",
      400,
    );
    const body = scopeRequestV2Schema.parse(r.body),
      id = await activeCatalogId();
    invariant(id, "MATH_EMPTY_CATALOG", 422);
    const catalog = await loadCatalog(id, body.subjectId);
    const preview = makePreview(resolveScopeV2(body, catalog), randomUUID());
    await savePreview(preview);
    return {
      schemaVersion: 2,
      id: preview.id,
      previewId: preview.id,
      scopeHash: preview.scopeHash,
      catalogId: id,
      curriculumHash: preview.curriculumHash,
      eligibleObjectiveCount: preview.targetObjectiveIds.length,
      compactSummary: {
        targets: preview.targetObjectiveIds.length,
        prerequisites: preview.prerequisites.length,
      },
      expiresAt: preview.expiresAt,
    };
  });
  const createSchema = z.strictObject({
    ...op,
    schemaVersion: z.literal(2),
    purpose: z.enum(["study", "verification"]).default("study"),
    previewId: anyId,
    scopeHash: hashSchema,
  });
  app.post(
    "/tests",
    {
      schema: { body: jsonSchema(createSchema) },
      preValidation: async (r) => {
        invariant(
          (r.body as any)?.schemaVersion === 2,
          "MATH_V1_CREATION_UNSUPPORTED",
          400,
        );
      },
    },
    async (r, reply) => {
      const body = createSchema.parse(r.body),
        existing = await readDoc<any>(
          collection("operation_receipts").doc(body.operationId),
        );
      const payload = {
        purpose: body.purpose,
        previewId: body.previewId,
        scopeHash: body.scopeHash,
        schemaVersion: body.schemaVersion,
      };
      if (existing) {
        invariant(
          existing.requestHash ===
            contentHash({ type: "create-test", payload }),
          "MATH_OPERATION_CONFLICT",
          409,
        );
        return reply.code(202).send(existing.result);
      }
      invariant(mathJobsConfigured(), "MATH_WORKER_UNAVAILABLE", 503);
      const preview = await getPreview(body.previewId);
      invariant(preview.expiresAt > Date.now(), "MATH_PREVIEW_EXPIRED", 409);
      invariant(
        preview.scopeHash === body.scopeHash,
        "MATH_SCOPE_CHANGED",
        409,
      );
      invariant(
        preview.schemaVersion === 2 && preview.targetObjectiveIds.length > 0,
        "MATH_SCOPE_BLOCKED",
        422,
      );
      let models: MathJob["frozenConfig"]["models"];
      try {
        const names = await Promise.all(
          ["generate", "validate", "grade"].map((f) =>
            resolveModel("full", `math/${f}`),
          ),
        );
        invariant(names.every(Boolean), "MATH_MODEL_UNAVAILABLE", 503);
        models = { generate: names[0], validate: names[1], grade: names[2] };
      } catch {
        throw new MathError("MATH_MODEL_UNAVAILABLE", 503);
      }
      const profileCatalog = await loadCatalog(
        preview.catalogId,
        preview.request.subjectId,
      );
      const {
        id: _previewId,
        scopeHash: _previewHash,
        expiresAt: _previewExpiry,
        ...frozenScope
      } = preview;
      const testId = randomUUID(),
        jobId = `${testId}-e0-q1`,
        testRef = collection("tests").doc(testId),
        scopeChunks = await writeChunks(testRef, "scope_chunks", frozenScope),
        plan = planNextQuestion(preview, profileCatalog, 1),
        job = {
          ...makeJob(jobId, testId, "generate", models),
          planId: plan.id,
          ordinal: 1,
          generationEpoch: 0,
        };
      const result = await globalOperation(
        "create-test",
        body.operationId,
        payload,
        async (tx) => {
          const settings = await readDoc<any>(
              collection("settings").doc("main"),
              tx,
            ),
            meta = await requiredDoc<any>(
              collection("scope_previews").doc(body.previewId),
              tx,
            ),
            activeJobs = await tx.get(
              collection("jobs")
                .where("type", "==", "generate")
                .where("state", "in", ["queued", "running", "retry_wait"])
                .limit(4),
            );
          invariant(
            settings?.activeCatalogId === preview.catalogId,
            "CATALOG_CHANGED",
            409,
          );
          invariant(meta.expiresAt > Date.now(), "MATH_PREVIEW_EXPIRED", 409);
          invariant(activeJobs.size < 3, "MATH_JOB_LIMIT", 429);
          const now = Date.now(),
            test: MathTest = {
              purpose: body.purpose,
              id: testId,
              schemaVersion: 2,
              generationMode:
                preview.request.questionLimit === null
                  ? "continuous"
                  : "finite",
              questionLimit: preview.request.questionLimit ?? null,
              generationState: "queued",
              nextOrdinal: 2,
              generatedCount: 0,
              answeredCount: 0,
              invalidCount: 0,
              currentQuestionId: null,
              pendingGenerationJobId: jobId,
              generationEpoch: 0,
              score: 0,
              maxScore: 0,
              pendingGrades: 0,
              catalogId: preview.catalogId,
              scopeHash: preview.scopeHash,
              config: preview.request,
              state: "generating",
              revision: 0,
              generationJobId: jobId,
              currentSittingId: null,
              questionIds: [],
              answeredQuestionIds: [],
              invalidQuestionIds: [],
              revealedQuestionIds: [],
              createdAt: now,
              updatedAt: now,
            };
          tx.create(testRef, bounded({ ...test, scopeChunks }));
          tx.create(
            testRef.collection("question_plans").doc(plan.id),
            bounded(plan),
          );
          for (const id of plan.targetObjectiveIds)
            tx.create(testRef.collection("objective_counts").doc(id), {
              count: 1,
            });
          tx.create(collection("jobs").doc(jobId), bounded(job));
          return { schemaVersion: 2, testId, jobId, revision: 0 };
        },
      );
      await enqueueMathJob(job).catch(() => {});
      return reply.code(202).send(result);
    },
  );
  app.get<{
    Querystring: {
      subjectId?: string;
      state?: string;
      cursor?: string;
      limit?: number;
    };
  }>(
    "/tests",
    {
      schema: {
        querystring: jsonSchema(
          z.strictObject({
            subjectId: idSchema.optional(),
            state: z
              .enum([
                "generating",
                "generation_failed",
                "ready",
                "in_progress",
                "completed",
                "cancelled",
              ])
              .optional(),
            cursor: anyId.optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
        ),
      },
    },
    async (r) => {
      let query: FirebaseFirestore.Query = collection("tests");
      if (r.query.subjectId)
        query = query.where("config.subjectId", "==", r.query.subjectId);
      if (r.query.state) query = query.where("state", "==", r.query.state);
      let q = query
        .orderBy("updatedAt", "desc")
        .orderBy(FieldPath.documentId(), "desc");
      if (r.query.cursor) {
        const doc = await requiredDoc<any>(
          collection("tests").doc(r.query.cursor),
        );
        q = q.startAfter(doc.updatedAt, r.query.cursor);
      }
      const docs = await q.limit((r.query.limit ?? 50) + 1).get(),
        rows = docs.docs.slice(0, r.query.limit ?? 50);
      return {
        items: rows.map((d) => {
          return publicTest(d.data() as MathTest);
        }),
        nextCursor: docs.size > rows.length ? rows.at(-1)?.id : null,
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/tests/:id",
    { schema: { params: params({ id: anyId }) } },
    async (r) => testView(r.params.id),
  );
  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: number };
  }>(
    "/tests/:id/scope",
    {
      schema: {
        params: params({ id: anyId }),
        querystring: jsonSchema(
          z.strictObject({
            cursor: z.string().regex(/^\d+$/).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
        ),
      },
    },
    async (r) => {
      const scope = await getScope(r.params.id),
        items = [
          ...scope.targets.map((ref) => ({ role: "target", ref })),
          ...scope.prerequisites.map((ref) => ({ role: "prerequisite", ref })),
          ...scope.baseline.map((ref) => ({ role: "baseline", ref })),
          ...scope.givens.map((ref) => ({ role: "given", ref })),
        ],
        offset = Number(r.query.cursor ?? 0),
        limit = r.query.limit ?? 50;
      return {
        schemaVersion: scope.schemaVersion ?? 1,
        catalogId: scope.catalogId,
        items: items.slice(offset, offset + limit),
        nextCursor:
          offset + limit < items.length ? String(offset + limit) : null,
      };
    },
  );
  for (const kind of ["questions", "attempts"] as const)
    app.get<{
      Params: { id: string };
      Querystring: { cursor?: string; limit?: number };
    }>(
      `/tests/:id/${kind}`,
      {
        schema: {
          params: params({ id: anyId }),
          querystring: jsonSchema(
            z.strictObject({
              cursor: anyId.optional(),
              limit: z.coerce.number().int().min(1).max(100).default(20),
            }),
          ),
        },
      },
      async (r) => {
        const ref = collection("tests").doc(r.params.id);
        const test = await requiredDoc<MathTest>(ref);
        let result: {
          items: FirebaseFirestore.DocumentData[];
          nextCursor: string | null;
        };
        if (test.schemaVersion === 2) {
          const field = kind === "questions" ? "ordinal" : "sequence";
          let query: FirebaseFirestore.Query = ref
            .collection(kind)
            .orderBy(field);
          if (r.query.cursor) {
            const cursor = await requiredDoc<any>(
              ref.collection(kind).doc(r.query.cursor),
            );
            query = query.startAfter(cursor[field]);
          }
          const limit = r.query.limit ?? 20,
            snapshot = await query.limit(limit + 1).get(),
            rows = snapshot.docs.slice(0, limit);
          result = {
            items: rows.map((d) => d.data()),
            nextCursor: snapshot.size > limit ? rows.at(-1)!.id : null,
          };
        } else
          result = await page(
            ref.collection(kind),
            r.query.cursor,
            r.query.limit,
          );
        return kind === "questions"
          ? {
              ...result,
              items: result.items.map((q) => publicQuestion(q as any)),
            }
          : result;
      },
    );
  app.get<{ Params: { id: string; questionId: string } }>(
    "/tests/:id/questions/:questionId",
    { schema: { params: params({ id: anyId, questionId: idSchema }) } },
    async (r) => {
      const ref = collection("tests").doc(r.params.id);
      await requiredDoc<MathTest>(ref);
      const question = await requiredDoc<any>(
        ref.collection("questions").doc(r.params.questionId),
      );
      const attempts = await ref
        .collection("attempts")
        .where("questionId", "==", question.id)
        .limit(1)
        .get();
      return {
        question: publicQuestion(question),
        draft: await readDoc(ref.collection("drafts").doc(question.id)),
        attempt: attempts.docs[0]?.data() ?? null,
      };
    },
  );
  app.get<{ Params: { id: string; attemptId: string } }>(
    "/tests/:id/attempts/:attemptId",
    { schema: { params: params({ id: anyId, attemptId: anyId }) } },
    async (r) =>
      requiredDoc<Attempt>(
        collection("tests")
          .doc(r.params.id)
          .collection("attempts")
          .doc(r.params.attemptId),
      ),
  );
  const operations: [string, TestAction, z.ZodType, "POST" | "PUT"][] = [
    ...(
      [
        "start",
        "resume",
        "end-sitting",
        "cancel",
        "retry-generation",
        "next-question",
        "finish",
      ] as const
    ).map(
      (a) =>
        [`/tests/:id/${a}`, a, z.strictObject(revision), "POST"] as [
          string,
          TestAction,
          z.ZodType,
          "POST",
        ],
    ),
    [
      "/tests/:id/accept-partial",
      "accept-partial",
      z.strictObject({
        ...revision,
        acceptedQuestionIds: z.array(idSchema).min(1).max(20),
      }),
      "POST",
    ],
    [
      "/tests/:id/drafts/:questionId",
      "draft",
      z.strictObject({
        ...op,
        text: z.string().max(32768),
        expectedDraftRevision: z.number().int().nonnegative(),
      }),
      "PUT",
    ],
    [
      "/tests/:id/attempts",
      "attempts",
      z.strictObject({
        ...revision,
        questionId: idSchema,
        sittingId: anyId,
        answerText: z.string().max(32768).default(""),
        paper: z.boolean().default(false),
      }),
      "POST",
    ],
    [
      "/tests/:id/skip",
      "skip",
      z.strictObject({
        ...revision,
        questionId: idSchema,
        reason: z.string().max(1000).default(""),
      }),
      "POST",
    ],
    [
      "/tests/:id/reveal",
      "reveal",
      z.strictObject({
        ...revision,
        questionId: idSchema,
        hint: z.boolean().default(false),
      }),
      "POST",
    ],
    [
      "/tests/:id/review",
      "review",
      z.strictObject({
        ...op,
        action: z.enum(["start", "next", "finish"]),
        reviewRevision: z.number().int().nonnegative(),
      }),
      "POST",
    ],
    [
      "/tests/:id/questions/:questionId/invalidate",
      "invalidate",
      z.strictObject({ ...revision, reason: z.string().min(1).max(2000) }),
      "POST",
    ],
    [
      "/tests/:id/attempts/:attemptId/assessment",
      "assessment",
      z.strictObject({
        ...op,
        expectedGradeVersion: z.number().int().nonnegative(),
        criterionScores: z
          .array(
            z.strictObject({
              criterionId: idSchema,
              points: z.number().nonnegative().max(100),
            }),
          )
          .max(30),
        reason: z.string().min(1).max(2000),
      }),
      "PUT",
    ],
    [
      "/tests/:id/attempts/:attemptId/retry-grade",
      "retry-grade",
      z.strictObject({
        ...op,
        expectedGradeVersion: z.number().int().nonnegative(),
      }),
      "POST",
    ],
  ];
  for (const [url, action, schema, method] of operations)
    app.route<{
      Params: { id: string; questionId?: string; attemptId?: string };
    }>({
      method,
      url,
      schema: {
        params: params({
          id: anyId,
          ...(url.includes(":questionId") ? { questionId: idSchema } : {}),
          ...(url.includes(":attemptId") ? { attemptId: anyId } : {}),
        }),
        body: jsonSchema(schema),
      },
      handler: async (r, reply) => {
        if (action === "attempts")
          invariant(
            mathJobsConfigured() || (r.body as any).paper,
            "MATH_WORKER_UNAVAILABLE",
            503,
          );
        const body = schema.parse(r.body) as Record<string, unknown>;
        const result = await applyTestOperation(r.params.id, action, {
          ...body,
          ...(r.params.questionId ? { questionId: r.params.questionId } : {}),
          ...(r.params.attemptId ? { attemptId: r.params.attemptId } : {}),
        });
        if (result.jobId) {
          const job = await requiredDoc<MathJob>(
            collection("jobs").doc(result.jobId as string),
          );
          await enqueueMathJob(job).catch(() => {});
        }
        return reply
          .code(
            action === "attempts" ||
              (action === "next-question" && result.jobId)
              ? 202
              : 200,
          )
          .send(result);
      },
    });
  app.get<{ Params: { jobId: string } }>(
    "/jobs/:jobId",
    { schema: { params: params({ jobId: anyId }) } },
    async (r) => {
      const j = await requiredDoc<MathJob>(
        collection("jobs").doc(r.params.jobId),
      );
      return {
        schemaVersion: j.planId ? 2 : 1,
        id: j.id,
        type: j.type,
        state: j.state,
        cursor: j.cursor,
        stage: j.stage,
        lastError: j.lastError,
        nextWakeAt: j.nextWakeAt,
        calls: j.calls,
        tokens: j.tokens,
      };
    },
  );
  const reportSchema = z.strictObject({
    ...op,
    testId: anyId,
    questionId: idSchema,
    reason: z.enum([
      "outside-scope",
      "incorrect-answer",
      "missing-conditions",
      "other",
    ]),
    details: z.string().max(8000),
  });
  app.post(
    "/problem-reports",
    { schema: { body: jsonSchema(reportSchema) } },
    async (r) => {
      const body = reportSchema.parse(r.body),
        id = randomUUID();
      return globalOperation("report", body.operationId, body, async (tx) => {
        const test = await requiredDoc<MathTest>(
          collection("tests").doc(body.testId),
          tx,
        );
        const question = await readDoc(
          collection("tests")
            .doc(body.testId)
            .collection("questions")
            .doc(body.questionId),
          tx,
        );
        invariant(
          test.schemaVersion === 2
            ? !!question
            : test.questionIds.includes(body.questionId),
          "MATH_QUESTION_NOT_FOUND",
          404,
        );
        tx.create(collection("problem_reports").doc(id), {
          id,
          testId: body.testId,
          questionId: body.questionId,
          reason: body.reason,
          details: body.details,
          state: "open",
          createdAt: Date.now(),
        });
        return { reportId: id };
      });
    },
  );
};
