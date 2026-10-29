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
} from "../math-store.js";
import { generateMathQuestions, gradeMathAnswer } from "../math-llm.js";
import type {
  MathBook,
  MathTest,
  MathKind,
  MathDifficulty,
} from "../math-types.js";
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
    req.log.error({ err }, "Math operation failed");
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
      kinds: MathKind[];
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
          difficulty: { enum: ["easy", "standard", "hard"] },
        },
        ["operationId", "bookId", "chapterIds", "kinds", "difficulty"],
      ),
    },
    async (req) => {
      const input = req.body;
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
        kinds: input.kinds,
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
            test.questions = await generateMathQuestions(
              test,
              await mathSources(test.sourceVersionIds),
            );
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
              (q) => !test.answers[q.id]?.grade,
            );
            if (test.status !== "active" || current?.id !== questionId)
              throw new MathError(409, "MATH_INVALID_STATE");
            test.answers[questionId] = { text, operationId };
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
              if (test.questions.every((q) => test.answers[q.id]?.grade))
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
              if (q && draft)
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
    Body: { operationId: string; version: number };
  }>(
    "/tests/:id/next",
    { schema: { ...bodySchema(operation), params: paramSchema } },
    async (req) => {
      const { operationId, version } = req.body;
      return publicMathTest(
        await runMathOperation(
          req.params.id,
          version,
          operationId,
          { action: "next" },
          (test) => {
            if (test.mode !== "continuous") {
              if (test.status !== "active" || test.phase !== "feedback")
                throw new MathError(409, "MATH_INVALID_STATE");
              return test;
            }
            if (
              !["created", "active"].includes(test.status) ||
              !["ready", "feedback"].includes(test.phase ?? "")
            )
              throw new MathError(409, "MATH_INVALID_STATE");
            test.status = "active";
            return test;
          },
          async (test) => {
            if (test.mode !== "continuous") {
              const next = test.questions.find(
                (q) => !test.answers[q.id]?.grade,
              );
              if (!next) throw new MathError(409, "MATH_INVALID_STATE");
              test.currentQuestionId = next.id;
              test.phase = "question";
              return test;
            }
            const sources = await mathSources(test.sourceVersionIds);
            const recent = await recentMathPrompts(test.id);
            const [q] = await generateMathQuestions(
              { ...test, count: 1 },
              sources,
              {
                recent,
                isDuplicate: (prompt) => duplicateMathPrompt(test.id, prompt),
              },
            );
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
