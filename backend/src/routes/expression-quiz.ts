import type { FastifyPluginAsync } from "fastify";
import {
  getAllExpressions,
  getExpression,
  getExpressionGroup,
  getSpeakingWritingSession,
  saveSpeakingWritingSession,
  getSpeakingWritingConfig,
} from "../firestore.js";
import { callLLM, stripMarkdownFences } from "../llm.js";
import type {
  Expression,
  ExpressionQuizSubsession,
  ExpressionQuizQuestion,
  CorrectionResult,
  SpeakingWritingSession,
} from "../types.js";

const expressionQuizRoutes: FastifyPluginAsync = async (fastify) => {
  const { outputSchema, prompts: basePrompts } = await getSpeakingWritingConfig();

  // Helper: load or stub the S&W session for a language
  async function loadOrCreateSWSession(language: string): Promise<SpeakingWritingSession> {
    const existing = await getSpeakingWritingSession(language);
    if (existing) return existing;
    return {
      sessionId: language,
      language,
      mode: "speaking",
      useCase: "",
      startedAt: new Date().toISOString(),
      status: "in-progress",
      corrections: [],
      currentIndex: 0,
    };
  }

  // POST /start
  fastify.post<{
    Body: {
      language: string;
      questionCount?: number;
      purposeFilter?: ("speaking" | "writing")[];
      groupIds?: string[];
    };
  }>(
    "/start",
    {
      schema: {
        body: {
          type: "object",
          required: ["language"],
          properties: {
            language: { type: "string" },
            questionCount: { type: "number", minimum: 1 },
            purposeFilter: { type: "array", items: { type: "string", enum: ["speaking", "writing"] } },
            groupIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, purposeFilter, groupIds } = request.body;

      let pool = await getAllExpressions(language);

      if (groupIds && groupIds.length > 0) {
        const groupDocs = await Promise.all(groupIds.map((id) => getExpressionGroup(id)));
        const union = new Set<string>();
        for (const g of groupDocs) {
          if (g) for (const eid of g.expressionIds) union.add(eid);
        }
        pool = pool.filter((e) => union.has(e.id));
      }

      if (purposeFilter && purposeFilter.length > 0) {
        pool = pool.filter(
          (e) => !e.purpose || e.purpose.length === 0 || e.purpose.some((p) => purposeFilter.includes(p))
        );
      }

      if (pool.length === 0) {
        return reply.badRequest("No expressions match the given filters");
      }

      const count = questionCount ? Math.min(questionCount, pool.length) : Math.min(10, pool.length);
      const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, count);

      const questions: ExpressionQuizQuestion[] = shuffled.map((expr) => ({
        expressionId: expr.id,
        phrase: expr.phrase,
        context: expr.context,
        ...(expr.description ? { description: expr.description } : {}),
      }));

      const subsession: ExpressionQuizSubsession = {
        startedAt: new Date().toISOString(),
        status: "in-progress",
        score: { correct: 0, total: questions.length },
        questions,
        ...(purposeFilter && purposeFilter.length > 0 ? { purposeFilter } : {}),
        ...(groupIds && groupIds.length > 0 ? { groupFilter: groupIds } : {}),
      };

      const swSession = await loadOrCreateSWSession(language);
      swSession.expressionQuiz = subsession;
      await saveSpeakingWritingSession(swSession);
      return reply.status(201).send(subsession);
    }
  );

  // POST /answer — submit user input; returns LLM correction
  fastify.post<{
    Body: { language: string; expressionId: string; userInput: string };
  }>(
    "/answer",
    {
      schema: {
        body: {
          type: "object",
          required: ["language", "expressionId", "userInput"],
          properties: {
            language: { type: "string" },
            expressionId: { type: "string" },
            userInput: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, expressionId, userInput } = request.body;

      const swSession = await getSpeakingWritingSession(language);
      const subsession = swSession?.expressionQuiz;
      if (!subsession) return reply.notFound("No expression quiz session found");
      if (subsession.status === "completed") return reply.badRequest("Session already completed");

      const question = subsession.questions.find(
        (q) => q.expressionId === expressionId && q.userInput === undefined
      );
      if (!question) return reply.notFound("Question not found or already answered");

      const expr = await getExpression(expressionId);
      if (!expr) return reply.notFound("Expression not found");

      const basePrompt = basePrompts[language];
      if (!basePrompt) return reply.badRequest(`Unsupported language: ${language}`);

      const systemPrompt = [
        basePrompt,
        `## Expression to Practice`,
        `Phrase: ${expr.phrase}`,
        `Context: ${expr.context}`,
        ...(expr.description ? [`Description: ${expr.description}`] : []),
        ``,
        `Evaluate whether the user's sentence appropriately uses this expression in the given context.`,
      ].join("\n");

      const purposeHint = expr.purpose?.length ? expr.purpose.join("/") : "speaking/writing";
      const userPrompt = `Mode: ${purposeHint}\nContext: ${expr.context}\n\nText to correct:\n${userInput}`;

      let correctionResult: CorrectionResult;
      try {
        const raw = await callLLM({ system: systemPrompt, user: userPrompt, schema: outputSchema, tier: "full", route: "expression-quiz/answer" });
        correctionResult = JSON.parse(stripMarkdownFences(raw)) as CorrectionResult;
      } catch (err) {
        fastify.log.error({ err, expressionId }, "LLM correction failed for expression quiz");
        return reply.internalServerError("Failed to get correction");
      }

      question.userInput = userInput;
      question.correctionResult = correctionResult;
      swSession!.expressionQuiz = subsession;
      await saveSpeakingWritingSession(swSession!);

      return { expressionQuiz: subsession, correctionResult };
    }
  );

  // POST /grade — self-grade a question
  fastify.post<{
    Body: { language: string; expressionId: string; correct: boolean };
  }>(
    "/grade",
    {
      schema: {
        body: {
          type: "object",
          required: ["language", "expressionId", "correct"],
          properties: {
            language: { type: "string" },
            expressionId: { type: "string" },
            correct: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, expressionId, correct } = request.body;

      const swSession = await getSpeakingWritingSession(language);
      const subsession = swSession?.expressionQuiz;
      if (!subsession) return reply.notFound("No expression quiz session found");
      if (subsession.status === "completed") return reply.badRequest("Session already completed");

      const question = subsession.questions.find(
        (q) => q.expressionId === expressionId && q.userCorrect === undefined && q.userInput !== undefined
      );
      if (!question) return reply.notFound("Question not found or not yet answered");

      question.userCorrect = correct;
      if (correct) {
        subsession.score.correct++;
      } else {
        const expr = await getExpression(expressionId);
        if (expr) {
          subsession.questions.push({
            expressionId,
            phrase: question.phrase,
            context: question.context,
            ...(question.description ? { description: question.description } : {}),
          });
          subsession.score.total++;
        }
      }

      const allDone = subsession.questions.every((q) => q.userCorrect !== undefined);
      if (allDone) {
        subsession.status = "completed";
        subsession.completedAt = new Date().toISOString();
      }

      swSession!.expressionQuiz = subsession;
      await saveSpeakingWritingSession(swSession!);
      return { expressionQuiz: subsession };
    }
  );

  // GET /session/language/:language — returns the expression quiz subsession
  fastify.get<{ Params: { language: string } }>(
    "/session/language/:language",
    async (request, reply) => {
      const swSession = await getSpeakingWritingSession(request.params.language);
      if (!swSession?.expressionQuiz) return reply.notFound("No expression quiz session found");
      return swSession.expressionQuiz;
    }
  );
};

export default expressionQuizRoutes;
