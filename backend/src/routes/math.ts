import type { FastifyPluginAsync } from "fastify";
import {
  mathHash,
  mathText,
  publicMathTest,
  sourceScope,
  MATH_INPUT_BYTES,
} from "../math-core.js";
import {
  MathError,
  booksCollection,
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
import { generateMathQuestions, gradeMathAnswer } from "../math-llm.js";
import type {
  MathBook,
  MathTest,
  MathKind,
  MathDifficulty,
  TaskKind,
} from "../math-types.js";
import { db } from "../firestore.js";
import { loadMathCurriculum } from "../math-publication.js";
import { ensureMathPromptVersion } from "../math-prompt-store.js";
import { mathPromptVersion } from "../math-prompt-loader.js";
import { resolveModel } from "../llm.js";
const id = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" };
const operation = { operationId: id, version: { type: "integer", minimum: 0 } };
const bodySchema = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({
  body: { type: "object", additionalProperties: false, properties, required },
});
const paramSchema = { type: "object", properties: { id }, required: ["id"] };
const mathRoutes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, req, reply) => {
    const error = err as Error & { statusCode?: number };
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({
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
        statusCode: error.statusCode,
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
    { schema: { params: paramSchema } },
    async (req) => (await mathSources([req.params.id]))[0],
  );
  app.get("/tests", async () => {
    const snapshot = await testsCollection()
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    return snapshot.docs.map((doc) => {
      const t = doc.data() as MathTest;
      return {
        id: t.id,
        title: t.book.title,
        status: t.status,
        createdAt: t.createdAt,
        count: t.count,
        mode: t.mode ?? "fixed",
        assessmentVersion: t.assessmentVersion ?? 1,
        ...(t.assessmentVersion === 2
          ? {
              publicationId: t.publicationId,
              curriculumRevision: t.curriculumRevision,
              taskKinds: t.taskKinds,
            }
          : {}),
        difficulty: t.difficulty,
        answered:
          t.stats?.answered ??
          Object.values(t.answers).filter((a) => a.grade).length,
      };
    });
  });
  app.get<{ Params: { id: string } }>(
    "/tests/:id",
    { schema: { params: paramSchema } },
    async (req) => publicMathTest(await getMathTest(req.params.id)),
  );
  app.post<{
    Body: {
      operationId: string;
      bookId: string;
      chapterIds: string[];
      count?: number;
      mode?: "fixed" | "continuous";
      kinds?: MathKind[];
      assessmentVersion?: 2;
      taskKinds?: TaskKind[];
      difficulty: MathDifficulty;
    };
  }>(
    "/tests",
    {
      schema: bodySchema(
        {
          operationId: id,
          bookId: id,
          chapterIds: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            uniqueItems: true,
            items: id,
          },
          mode: { enum: ["fixed", "continuous"] },
          count: { type: "integer", minimum: 1, maximum: 10 },
          kinds: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { enum: ["definition", "calculation", "proof"] },
          },
          assessmentVersion: { const: 2 },
          taskKinds: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: { enum: ["prove", "determine", "compute", "derive"] },
          },
          difficulty: { enum: ["easy", "standard", "hard"] },
        },
        ["operationId", "bookId", "chapterIds", "difficulty"],
      ),
    },
    async (req) => {
      const input = req.body;
      const existing = await testsCollection().doc(input.operationId).get();
      if (existing.exists) {
        if (existing.get("requestHash") !== mathHash(JSON.stringify(input)))
          throw new MathError(409, "MATH_OPERATION_CONFLICT");
        return publicMathTest(await getMathTest(input.operationId));
      }
      if ((input.assessmentVersion === 2 || input.taskKinds) && input.kinds)
        throw new MathError(400, "MATH_INVALID_REQUEST");
      const mode =
        input.mode ?? (input.count === undefined ? "continuous" : "fixed");
      if (
        (mode === "fixed" && input.count === undefined) ||
        (mode === "continuous" && input.count !== undefined)
      )
        throw new MathError(400, "MATH_INVALID_REQUEST");
      const bookDoc = await booksCollection().doc(input.bookId).get();
      if (!bookDoc.exists) throw new MathError(404, "MATH_BOOK_NOT_FOUND");
      const book = bookDoc.data() as MathBook;
      const v2 = !!book.publicationId;
      if (!v2 && (input.assessmentVersion === 2 || input.taskKinds))
        throw new MathError(422, "MATH_CURRICULUM_UNAVAILABLE");
      if (v2) {
        await loadMathCurriculum(db, book);
        await ensureMathPromptVersion();
      }
      const kindMap: Record<MathKind, TaskKind> = {
        definition: "determine",
        calculation: "compute",
        proof: "prove",
      };
      const taskKinds =
        input.taskKinds ??
        (input.kinds
          ? input.kinds.map((k) => kindMap[k])
          : (["prove", "determine", "compute", "derive"] as TaskKind[]));
      let sourceVersionIds: string[];
      try {
        sourceVersionIds = sourceScope(book, input.chapterIds);
      } catch {
        throw new MathError(400, "MATH_INVALID_SCOPE");
      }
      const sources = await mathSources(sourceVersionIds);
      if (
        Buffer.byteLength(JSON.stringify(sources)) >
        MATH_INPUT_BYTES - 10_000
      )
        throw new MathError(413, "MATH_SCOPE_TOO_LARGE");
      const now = new Date().toISOString();
      const test: MathTest = {
        id: input.operationId,
        book,
        chapterIds: book.chapters
          .filter((c) => input.chapterIds.includes(c.id))
          .map((c) => c.id),
        sourceVersionIds,
        count: input.count ?? 0,
        ...(mode === "continuous"
          ? {
              mode,
              phase: "ready" as const,
              generatedCount: 0,
              stats: { answered: 0, correct: 0, partial: 0, incorrect: 0 },
            }
          : {}),
        ...(v2
          ? {
              assessmentVersion: 2 as const,
              assistanceReporting:
                input.assessmentVersion === 2 || !!input.taskKinds,
              taskKinds,
              publicationId: book.publicationId!,
              curriculumRevision: book.curriculumRevision!,
              difficultyPolicyVersion: "assessment-v1",
              promptVersion: mathPromptVersion,
              modelSelections: Object.fromEntries(
                await Promise.all(
                  ["math/generate", "math/validate", "math/grade"].map(
                    async (route) => [route, await resolveModel("full", route)],
                  ),
                ),
              ),
            }
          : {}),
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
      return publicMathTest(
        await createMathTest(test, mathHash(JSON.stringify(input))),
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/tests/:id/objectives",
    { schema: { params: paramSchema } },
    async (req) => mathObjectiveProgress(await getMathTest(req.params.id)),
  );
  app.post<{
    Params: { id: string };
    Body: {
      operationId: string;
      version: number;
      questionId: string;
      kind: "solution_view";
    };
  }>(
    "/tests/:id/assistance",
    {
      schema: {
        ...bodySchema({
          ...operation,
          questionId: id,
          kind: { const: "solution_view" },
        }),
        params: paramSchema,
      },
    },
    async (req) =>
      publicMathTest(
        await runMathOperation(
          req.params.id,
          req.body.version,
          req.body.operationId,
          {
            action: "assistance",
            questionId: req.body.questionId,
            kind: req.body.kind,
          },
          (test) => {
            const q = test.questions.find((q) => q.id === req.body.questionId);
            if (!q || test.status !== "active")
              throw new MathError(409, "MATH_INVALID_STATE");
            q.assistanceStatus = "viewed";
            return test;
          },
          async (test) => test,
        ),
      ),
  );
  app.post<{
    Params: { id: string };
    Body: { operationId: string; version: number };
  }>(
    "/tests/:id/generate",
    { schema: { ...bodySchema(operation), params: paramSchema } },
    async (req) => {
      const { version, operationId } = req.body;
      return publicMathTest(
        await runMathOperation(
          req.params.id,
          version,
          operationId,
          { action: "generate" },
          (test) => {
            if (test.mode === "continuous")
              throw new MathError(409, "MATH_INVALID_STATE");
            if (
              !["created", "generation_failed", "generating"].includes(
                test.status,
              )
            )
              throw new MathError(409, "MATH_INVALID_STATE");
            test.status = "generating";
            return test;
          },
          async (test) => {
            const curriculum =
              test.assessmentVersion === 2
                ? await frozenCurriculum(test)
                : undefined;
            if (curriculum) await ensureAssessmentPlans(test);
            test.questions = await generateMathQuestions(
              test,
              await mathSources(test.sourceVersionIds),
              curriculum
                ? {
                    curriculum,
                    recent: [],
                    isDuplicate: async () => false,
                    replan: async (excluded) => {
                      await ensureAssessmentPlans(test, excluded);
                    },
                  }
                : undefined,
            );
            delete test.pendingPlans;
            test.phase = "question";
            test.currentQuestionId = test.questions[0]?.id;
            test.status = "active";
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
      questionId: string;
      text: string;
    };
  }>(
    "/tests/:id/answer",
    {
      schema: {
        ...bodySchema({
          ...operation,
          questionId: id,
          text: { type: "string", minLength: 1, maxLength: 5000 },
        }),
        params: paramSchema,
      },
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
            const current = test.questions.find(
              (q) =>
                !test.answers[q.id]?.grade &&
                test.answers[q.id]?.submitted !== false,
            );
            if (test.status !== "active" || current?.id !== questionId)
              throw new MathError(409, "MATH_INVALID_STATE");
            test.answers[questionId] = {
              ...test.answers[questionId],
              text,
              operationId,
            };
            test.draft = text;
            return test;
          },
          async (test) => {
            const q = test.questions.find((q) => q.id === questionId)!;
            test.answers[questionId].grade = await gradeMathAnswer(
              test,
              q,
              text,
              await mathSources(test.sourceVersionIds),
            );
            test.draft = "";
            if (test.mode === "continuous") {
              test.phase = "feedback";
              const stats = test.stats!;
              stats.answered++;
              stats[test.answers[questionId].grade!.verdict]++;
            } else {
              test.phase = "feedback";
              test.currentQuestionId = questionId;
              if (
                test.questions.every(
                  (q) =>
                    test.answers[q.id]?.grade ||
                    test.answers[q.id]?.submitted === false,
                )
              )
                test.status = "completed";
            }
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
      schema: {
        ...bodySchema(
          {
            ...operation,
            action: { enum: ["pause", "resume", "finish"] },
            draft: { type: "string", maxLength: 5000 },
          },
          ["operationId", "version", "action"],
        ),
        params: paramSchema,
      },
    },
    async (req) => {
      const { version, operationId, action, draft = "" } = req.body;
      if (Buffer.byteLength(draft) > 20000)
        throw new MathError(400, "MATH_INVALID_ANSWER");
      return publicMathTest(
        await runMathOperation(
          req.params.id,
          version,
          operationId,
          { action, draft },
          (test) => {
            if (!["active", "paused"].includes(test.status))
              throw new MathError(409, "MATH_INVALID_STATE");
            test.draft = draft;
            if (
              action === "finish" &&
              test.mode === "continuous" &&
              test.phase === "question"
            ) {
              const q = test.questions[0];
              if (q)
                test.answers[q.id] = {
                  text: draft,
                  operationId,
                  submitted: false,
                };
            }
            test.status =
              action === "finish"
                ? "completed"
                : action === "pause"
                  ? "paused"
                  : "active";
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
        params: paramSchema,
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
      schema: {
        ...bodySchema(
          {
            ...operation,
            draft: { type: "string", maxLength: 5000 },
          },
          ["operationId", "version"],
        ),
        params: paramSchema,
      },
    },
    async (req) => {
      const { operationId, version, draft = "" } = req.body;
      if (draft && !mathText(draft, 20000))
        throw new MathError(400, "MATH_INVALID_ANSWER");
      return publicMathTest(
        await runMathOperation(
          req.params.id,
          version,
          operationId,
          { action: "next", draft },
          (test) => {
            if (test.mode !== "continuous") {
              if (
                test.status !== "active" ||
                !["question", "feedback"].includes(test.phase ?? "")
              )
                throw new MathError(409, "MATH_INVALID_STATE");
              if (test.phase === "question") {
                const q = test.questions.find(
                  (item) => item.id === test.currentQuestionId,
                );
                if (!q || test.answers[q.id]?.grade)
                  throw new MathError(409, "MATH_INVALID_STATE");
                test.answers[q.id] = {
                  ...test.answers[q.id],
                  text: draft,
                  operationId,
                  submitted: false,
                };
                test.draft = "";
                test.phase = "feedback";
              }
              return test;
            }
            if (
              !["created", "active"].includes(test.status) ||
              !["ready", "question", "feedback"].includes(test.phase ?? "")
            )
              throw new MathError(409, "MATH_INVALID_STATE");
            if (test.phase === "question") {
              const q = test.questions[0];
              if (!q || q.id !== test.currentQuestionId)
                throw new MathError(409, "MATH_INVALID_STATE");
              if (!test.answers[q.id]?.grade)
                test.answers[q.id] = {
                  text: draft,
                  operationId,
                  submitted: false,
                };
              test.draft = "";
            }
            test.status = "active";
            return test;
          },
          async (test) => {
            if (test.mode !== "continuous") {
              const next = test.questions.find(
                (q) =>
                  !test.answers[q.id]?.grade &&
                  test.answers[q.id]?.submitted !== false,
              );
              if (!next) {
                test.status = "completed";
                return test;
              }
              test.currentQuestionId = next.id;
              test.phase = "question";
              return test;
            }
            const sources = await mathSources(test.sourceVersionIds);
            const recent = await recentMathPrompts(test.id);
            const curriculum =
              test.assessmentVersion === 2
                ? await frozenCurriculum(test)
                : undefined;
            if (curriculum) await ensureAssessmentPlans(test);
            const [q] = await generateMathQuestions(
              { ...test, count: 1 },
              sources,
              {
                recent,
                ...(curriculum
                  ? {
                      curriculum,
                      replan: async (excluded: string[]) => {
                        await ensureAssessmentPlans(test, excluded);
                      },
                    }
                  : {}),
                isDuplicate: (prompt) => duplicateMathPrompt(test.id, prompt),
              },
            );
            delete test.pendingPlans;
            const number = (test.generatedCount ?? 0) + 1;
            q.id = `q${number}`;
            q.number = number;
            test.questions = [q];
            test.answers = {};
            test.currentQuestionId = q.id;
            test.generatedCount = number;
            test.phase = "question";
            test.draft = "";
            return test;
          },
        ),
      );
    },
  );
};
export default mathRoutes;
