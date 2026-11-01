import type { FastifyPluginAsync } from "fastify";
import { mathHash, mathText, publicMathTest } from "../math-core.js";
import { db } from "../firestore.js";
import {
  MathError,
  testsCollection,
  listMathBooks,
  mathSources,
  getMathTest,
  createMathTest,
  runMathOperation,
  mathQuestionHistory,
  recentMathPrompts,
  duplicateMathPrompt,
  frozenCurriculum,
  ensureAssessmentPlans,
  mathObjectiveProgress,
} from "../math-store.js";
import {
  prepareMathScopes,
  activeMathScopes,
  orderedMathScopes,
  scopeContext,
  questionMathContext,
  scopeKey,
} from "../math-scopes.js";
import { generateMathQuestions, gradeMathAnswer } from "../math-llm.js";
import { ensureMathPromptVersion } from "../math-prompt-store.js";
import { mathPromptVersion } from "../math-prompt-loader.js";
import { resolveModel } from "../llm.js";
import { loadMathCurriculum } from "../math-publication.js";
import type {
  MathTest,
  MathKind,
  TaskKind,
  MathDifficulty,
  MathScopeInput,
} from "../math-types.js";
const id = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" };
const operation = { operationId: id, version: { type: "integer", minimum: 0 } };
const draftSchema = { type: "string", maxLength: 5000 };
const chapterIds = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
  items: id,
};
const scopesSchema = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    additionalProperties: false,
    properties: { bookId: id, chapterIds },
    required: ["bookId", "chapterIds"],
  },
};
const params = { type: "object", properties: { id }, required: ["id"] };
const schema = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
  withParams = true,
) => ({
  body: { type: "object", additionalProperties: false, properties, required },
  ...(withParams ? { params } : {}),
});
async function models() {
  return Object.fromEntries(
    await Promise.all(
      ["math/generate", "math/validate", "math/grade"].map(async (route) => [
        route,
        await resolveModel("full", route),
      ]),
    ),
  );
}
function checkDraft(draft: string) {
  if (Buffer.byteLength(draft) > 20000)
    throw new MathError(400, "MATH_INVALID_ANSWER");
}
function currentQuestion(test: MathTest, questionId: string) {
  const q = test.questions.find((q) => q.id === questionId);
  if (!q || test.currentQuestionId !== questionId || test.status !== "active")
    throw new MathError(409, "MATH_INVALID_STATE");
  return q;
}
const mathRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, req, reply) => {
    const error = err as Error & { statusCode?: number };
    if (error.statusCode && error.statusCode < 500)
      return reply
        .code(error.statusCode)
        .send({
          code: error.message.startsWith("MATH_")
            ? error.message
            : "MATH_INVALID_REQUEST",
        });
    req.log.error(
      {
        errorType: error.name,
        code: /^(MATH_|INVALID_)/.test(error.message)
          ? error.message
          : "MATH_MODEL_OR_STORAGE_FAILED",
      },
      "Math operation failed",
    );
    return reply
      .code(error.message === "MATH_SCOPE_TOO_LARGE" ? 413 : 503)
      .send({
        code:
          error.message === "MATH_SCOPE_TOO_LARGE"
            ? error.message
            : "MATH_OPERATION_FAILED",
      });
  });
  app.get("/books", async () => listMathBooks());
  app.get<{ Params: { id: string } }>(
    "/chapters/:id",
    { schema: { params } },
    async (req) => (await mathSources([req.params.id]))[0],
  );
  app.get("/tests", async () => {
    const docs = await testsCollection()
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    return docs.docs.map((doc) => {
      const t = doc.data() as MathTest;
      const scopes = activeMathScopes(t);
      return {
        id: t.id,
        title: scopes.map((s) => s.book.title).join(" · "),
        status: t.status,
        createdAt: t.createdAt,
        mode: "continuous",
        difficulty: t.difficulty,
        answered:
          t.stats?.answered ??
          Object.values(t.answers ?? {}).filter((a) => a.grade).length,
        revealed: t.stats?.revealed ?? 0,
      };
    });
  });
  app.get<{ Params: { id: string } }>(
    "/tests/:id",
    { schema: { params } },
    async (req) => publicMathTest(await getMathTest(req.params.id)),
  );
  app.post<{
    Body: {
      operationId: string;
      scopes?: MathScopeInput[];
      bookId?: string;
      chapterIds?: string[];
      mode?: "continuous";
      assessmentVersion?: 2;
      kinds?: MathKind[];
      taskKinds?: TaskKind[];
      difficulty: MathDifficulty;
    };
  }>(
    "/tests",
    {
      schema: schema(
        {
          operationId: id,
          scopes: scopesSchema,
          bookId: id,
          chapterIds,
          mode: { const: "continuous" },
          count: false,
          assessmentVersion: { const: 2 },
          kinds: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { enum: ["definition", "calculation", "proof"] },
          },
          taskKinds: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: { enum: ["prove", "determine", "compute", "derive"] },
          },
          difficulty: { enum: ["easy", "standard", "hard"] },
        },
        ["operationId", "difficulty"],
        false,
      ),
    },
    async (req) => {
      const input = req.body,
        hash = mathHash(JSON.stringify(input));
      const existing = await testsCollection().doc(input.operationId).get();
      if (existing.exists) {
        if (existing.get("requestHash") !== hash)
          throw new MathError(409, "MATH_OPERATION_CONFLICT");
        return publicMathTest(await getMathTest(input.operationId));
      }
      if (
        (input.scopes && (input.bookId || input.chapterIds)) ||
        (!input.scopes && (!input.bookId || !input.chapterIds)) ||
        ((input.assessmentVersion || input.taskKinds) && input.kinds)
      )
        throw new MathError(400, "MATH_INVALID_REQUEST");
      const map: Record<MathKind, TaskKind> = {
        definition: "determine",
        calculation: "compute",
        proof: "prove",
      };
      const scopes = await prepareMathScopes(
        input.scopes ?? [
          { bookId: input.bookId!, chapterIds: input.chapterIds! },
        ],
        undefined,
        input.taskKinds ?? input.kinds?.map(k => map[k]) ??
          ["prove", "determine", "compute", "derive"],
      );
      await ensureMathPromptVersion();
      const first = scopes[0],
        now = new Date().toISOString();
      const test: MathTest = {
        id: input.operationId,
        ...first,
        scopes,
        scopeRevision: 0,
        scopeBookCounts: {},
        scopeChapterCounts: {},
        count: 0,
        mode: "continuous",
        phase: "ready",
        generatedCount: 0,
        stats: {
          answered: 0,
          correct: 0,
          partial: 0,
          incorrect: 0,
          revealed: 0,
        },
        assessmentVersion: 2,
        assistanceReporting: true,
        taskKinds: input.taskKinds ??
          input.kinds?.map((k) => map[k]) ?? [
            "prove",
            "determine",
            "compute",
            "derive",
          ],
        publicationId: first.book.publicationId,
        curriculumRevision: first.book.curriculumRevision,
        difficultyPolicyVersion: "assessment-v1",
        promptVersion: mathPromptVersion,
        modelSelections: await models(),
        kinds: input.kinds ?? ["definition", "calculation", "proof"],
        difficulty: input.difficulty,
        status: "created",
        questions: [],
        answers: {},
        draft: "",
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      return publicMathTest(await createMathTest(test, hash));
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      operationId: string;
      version: number;
      scopes: MathScopeInput[];
      draft?: string;
    };
  }>(
    "/tests/:id/scope",
    {
      schema: schema(
        { ...operation, scopes: scopesSchema, draft: draftSchema },
        ["operationId", "version", "scopes"],
      ),
    },
    async (req) => {
      const { operationId, version, scopes, draft } = req.body;
      if (draft !== undefined) checkDraft(draft);
      return publicMathTest(
        await runMathOperation(
          req.params.id,
          version,
          operationId,
          {
            action: "scope",
            scopes,
            ...(draft !== undefined ? { draft } : {}),
          },
          (test) => {
            if (test.status === "completed")
              throw new MathError(409, "MATH_INVALID_STATE");
            return test;
          },
          async (test) => {
            const prepared = await prepareMathScopes(scopes, test);
            test.scopes = prepared;
            test.scopeRevision = (test.scopeRevision ?? 0) + 1;
            test.scopeBookCounts = {};
            test.scopeChapterCounts = {};
            if (draft !== undefined) test.draft = draft;
            delete test.pendingPlans;
            delete test.pendingBookId;
            if (!test.promptVersion) {
              await ensureMathPromptVersion();
              test.promptVersion = mathPromptVersion;
              test.difficultyPolicyVersion = "assessment-v1";
              test.modelSelections = await models();
            }
            return test;
          },
        ),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/tests/:id/objectives",
    { schema: { params } },
    async (req) => mathObjectiveProgress(await getMathTest(req.params.id)),
  );
  for (const action of ["reveal", "assistance"] as const) {
    app.post<{
      Params: { id: string };
      Body: {
        operationId: string;
        version: number;
        questionId: string;
        draft?: string;
        kind?: "solution_view";
      };
    }>(
      `/tests/:id/${action}`,
      {
        schema: schema(
          {
            ...operation,
            questionId: id,
            ...(action === "assistance"
              ? { kind: { const: "solution_view" } }
              : { draft: draftSchema }),
          },
          [
            "operationId",
            "version",
            "questionId",
            ...(action === "assistance" ? ["kind"] : []),
          ],
        ),
      },
      async (req) => {
        const { version, operationId, questionId, draft } = req.body;
        if (draft !== undefined) checkDraft(draft);
        return publicMathTest(
          await runMathOperation(
            req.params.id,
            version,
            operationId,
            { action, questionId, ...(draft !== undefined ? { draft } : {}) },
            (test) => {
              const q = currentQuestion(test, questionId);
              q.assistanceStatus = "viewed";
              if (action === "reveal") {
                if (!q.revealedAt) {
                  q.revealedAt = new Date().toISOString();
                  test.stats!.revealed = (test.stats!.revealed ?? 0) + 1;
                }
                if (!test.answers[q.id]?.grade) test.phase = "solution";
                if (draft !== undefined) test.draft = draft;
              }
              return test;
            },
            async (test) => test,
          ),
        );
      },
    );
  }
  app.post<{
    Params: { id: string };
    Body: {
      operationId: string;
      version: number;
      questionId: string;
      text: string;
    };
  }>(
    "/tests/:id/answer",
    {
      schema: schema({
        ...operation,
        questionId: id,
        text: { type: "string", minLength: 1, maxLength: 5000 },
      }),
    },
    async (req) => {
      const { version, operationId, questionId, text } = req.body;
      if (!mathText(text, 20000))
        throw new MathError(400, "MATH_INVALID_ANSWER");
      return publicMathTest(
        await runMathOperation(
          req.params.id,
          version,
          operationId,
          { action: "answer", questionId, text },
          (test) => {
            const q = currentQuestion(test, questionId);
            if (test.answers[q.id]?.grade)
              throw new MathError(409, "MATH_INVALID_STATE");
            test.answers[q.id] = { ...test.answers[q.id], text, operationId };
            test.draft = text;
            return test;
          },
          async (test) => {
            const q = test.questions[0],
              context = await questionMathContext(test, q);
            const curriculum =
              context.assessmentVersion === 2
                ? await loadMathCurriculum(db, context.book)
                : undefined;
            test.answers[q.id].grade = await gradeMathAnswer(
              context,
              q,
              text,
              await mathSources(context.sourceVersionIds),
              curriculum,
            );
            test.draft = "";
            test.phase = "feedback";
            test.stats!.answered++;
            test.stats![test.answers[q.id].grade!.verdict]++;
            return test;
          },
        ),
      );
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      operationId: string;
      version: number;
      action: "pause" | "resume" | "finish";
      draft?: string;
    };
  }>(
    "/tests/:id/state",
    {
      schema: schema(
        {
          ...operation,
          action: { enum: ["pause", "resume", "finish"] },
          draft: draftSchema,
        },
        ["operationId", "version", "action"],
      ),
    },
    async (req) => {
      const { version, operationId, action, draft = "" } = req.body;
      checkDraft(draft);
      return publicMathTest(
        await runMathOperation(
          req.params.id,
          version,
          operationId,
          { action, draft },
          (test) => {
            if (!["created", "active", "paused"].includes(test.status))
              throw new MathError(409, "MATH_INVALID_STATE");
            test.draft = draft;
            const q = test.questions[0];
            if (action === "finish" && q && !test.answers[q.id]?.grade)
              test.answers[q.id] = {
                text: draft,
                operationId,
                submitted: false,
              };
            test.status =
              action === "finish"
                ? "completed"
                : action === "pause"
                  ? "paused"
                  : test.currentQuestionId
                    ? "active"
                    : "created";
            return test;
          },
          async (test) => test,
        ),
      );
    },
  );
  app.get<{ Params: { id: string }; Querystring: { after?: number } }>(
    "/tests/:id/questions",
    {
      schema: {
        params,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            after: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
        },
      },
    },
    async (req) =>
      mathQuestionHistory(
        await getMathTest(req.params.id),
        req.query.after ?? 0,
      ),
  );
  app.post<{
    Params: { id: string };
    Body: { operationId: string; version: number; draft?: string };
  }>(
    "/tests/:id/next",
    {
      schema: schema({ ...operation, draft: draftSchema }, [
        "operationId",
        "version",
      ]),
    },
    async (req) => {
      const { operationId, version, draft = "" } = req.body;
      checkDraft(draft);
      return publicMathTest(
        await runMathOperation(
          req.params.id,
          version,
          operationId,
          { action: "next", draft },
          (test) => {
            if (!["created", "active"].includes(test.status))
              throw new MathError(409, "MATH_INVALID_STATE");
            const q = test.questions[0];
            if (q && !test.answers[q.id]?.grade)
              test.answers[q.id] = {
                text: draft,
                operationId,
                submitted: false,
              };
            test.draft = "";
            test.status = "active";
            return test;
          },
          async (test) => {
            let last: unknown;
            for (const scope of orderedMathScopes(test)) {
              const context = scopeContext(test, scope);
              const curriculum =
                context.assessmentVersion === 2
                  ? await frozenCurriculum(context)
                  : undefined;
              try {
                if (curriculum) await ensureAssessmentPlans(context);
              } catch (error) {
                if ((error as Error).message === "MATH_NO_FEASIBLE_OBJECTIVE") {
                  last = error;
                  continue;
                }
                throw error;
              }
              const [q] = await generateMathQuestions(
                context,
                await mathSources(context.sourceVersionIds),
                {
                  recent: await recentMathPrompts(test.id),
                  ...(curriculum
                    ? {
                        curriculum,
                        replan: async (excluded) => {
                          await ensureAssessmentPlans(context, excluded);
                        },
                      }
                    : {}),
                  isDuplicate: (prompt) => duplicateMathPrompt(test.id, prompt),
                },
              );
              q.id = `q${(test.generatedCount ?? 0) + 1}`;
              q.number = (test.generatedCount ?? 0) + 1;
              q.bookId = scope.book.id;
              q.bookTitle = scope.book.title;
              q.chapterTitle = scope.book.chapters.find(
                (c) => c.id === q.chapterId,
              )?.title;
              q.scopeRevision = test.scopeRevision ?? 0;
              test.questions = [q];
              test.answers = {};
              test.currentQuestionId = q.id;
              test.generatedCount = q.number;
              test.phase = "question";
              test.draft = "";
              test.scopeBookCounts ??= {};
              test.scopeChapterCounts ??= {};
              test.scopeBookCounts[scope.book.id] =
                (test.scopeBookCounts[scope.book.id] ?? 0) + 1;
              const key = scopeKey(scope.book.id, q.chapterId);
              test.scopeChapterCounts[key] =
                (test.scopeChapterCounts[key] ?? 0) + 1;
              delete test.pendingPlans;
              delete test.pendingBookId;
              return test;
            }
            throw last ?? new MathError(422, "MATH_NO_FEASIBLE_OBJECTIVE");
          },
        ),
      );
    },
  );
};
export default mathRoutes;
