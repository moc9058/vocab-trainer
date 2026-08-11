import type { FastifyPluginAsync } from "fastify";
import {
  getAllExpressions,
  getExpressionGroup,
  getExpressionRecallSession,
  saveExpressionRecallSession,
  deleteExpressionRecallSession,
} from "../firestore.js";
import type {
  Expression,
  ExpressionGroup,
  ExpressionQuizDirection,
  ExpressionRecallQuestion,
  ExpressionRecallSession,
} from "../types.js";
import { shuffle, weightedInterleave } from "../quiz-utils.js";

const DEFAULT_DIRECTION: ExpressionQuizDirection = "phrase-to-context";

/** Which face of the card is shown as the question. The other side is the reveal. */
function promptFor(expr: Expression, direction: ExpressionQuizDirection): string {
  return direction === "context-to-phrase" ? expr.context : expr.phrase;
}

/** Assign each pooled expression to exactly one selected group — the first in
 *  `groupIds` order that contains it — so weighted draws have well-defined
 *  denominators and no expression is asked twice. Mirrors
 *  `grammar-quiz.ts:buildGrammarGroupMembership`. */
function buildExpressionGroupMembership(
  groupIds: string[],
  groupDocs: (ExpressionGroup | null)[],
  pool: Expression[]
): Record<string, Expression[]> {
  const byId = new Map(pool.map((e) => [e.id, e]));
  const assigned = new Set<string>();
  const membership: Record<string, Expression[]> = {};
  for (const id of groupIds) membership[id] = [];
  for (const g of groupDocs) {
    if (!g) continue;
    for (const eid of g.expressionIds) {
      if (byId.has(eid) && !assigned.has(eid)) {
        assigned.add(eid);
        membership[g.id].push(byId.get(eid)!);
      }
    }
  }
  return membership;
}

/** Re-draw the unanswered tail with the session's stored weights. Every quiz in
 *  this app regenerates on resume rather than serving a stale tail. */
function reweightUnanswered(
  unanswered: ExpressionRecallQuestion[],
  session: ExpressionRecallSession
): ExpressionRecallQuestion[] {
  const membership = session.groupMembership;
  if (!membership || Object.keys(membership).length === 0) return shuffle(unanswered);

  const byId = new Map<string, ExpressionRecallQuestion>();
  for (const q of unanswered) byId.set(q.expressionId, q);

  const buckets = Object.entries(membership).map(([gid, ids]) => ({
    weight: session.groupWeights?.[gid] ?? 1,
    items: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
  }));

  const ordered = weightedInterleave(buckets);
  // Anything the membership map doesn't know about (a retry copy of an item
  // whose group was since emptied) still has to be asked — append it.
  const placed = new Set(ordered.map((q) => q.expressionId));
  return [...ordered, ...unanswered.filter((q) => !placed.has(q.expressionId))];
}

const expressionRecallQuizRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /start
  fastify.post<{
    Body: {
      language: string;
      questionCount?: number;
      direction?: ExpressionQuizDirection;
      purposeFilter?: ("speaking" | "writing")[];
      groupIds?: string[];
      groupWeights?: Record<string, number>;
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
            direction: { type: "string", enum: ["phrase-to-context", "context-to-phrase"] },
            purposeFilter: { type: "array", items: { type: "string", enum: ["speaking", "writing"] } },
            groupIds: { type: "array", items: { type: "string" } },
            groupWeights: { type: "object", additionalProperties: { type: "number" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { language, questionCount, purposeFilter, groupIds, groupWeights } = request.body;
      const direction = request.body.direction ?? DEFAULT_DIRECTION;

      let pool = await getAllExpressions(language);

      let groupDocs: (ExpressionGroup | null)[] = [];
      if (groupIds && groupIds.length > 0) {
        groupDocs = await Promise.all(groupIds.map((id) => getExpressionGroup(id)));
        const union = new Set<string>();
        for (const g of groupDocs) {
          if (g) for (const eid of g.expressionIds) union.add(eid);
        }
        pool = pool.filter((e) => union.has(e.id));
      }

      if (purposeFilter && purposeFilter.length > 0) {
        // An untagged expression is always in scope — matches the writing quiz's
        // rule (`expression-quiz.ts`), so the two filters behave the same way.
        pool = pool.filter(
          (e) => !e.purpose || e.purpose.length === 0 || e.purpose.some((p) => purposeFilter.includes(p))
        );
      }

      // A card whose prompt face is blank is unanswerable, so drop it rather
      // than showing an empty question.
      pool = pool.filter((e) => promptFor(e, direction).trim().length > 0);

      if (pool.length === 0) {
        return reply.badRequest("No expressions match the given filters");
      }

      // Default to the ENTIRE matching pool, like the word and grammar quizzes:
      // weights decide the ORDER, never who makes the cut.
      const count = questionCount ? Math.min(questionCount, pool.length) : pool.length;

      let selected: Expression[];
      let groupMembership: Record<string, string[]> | undefined;
      if (groupIds && groupIds.length > 0) {
        const membership = buildExpressionGroupMembership(groupIds, groupDocs, pool);
        selected = weightedInterleave(
          groupIds.map((id) => ({ weight: groupWeights?.[id] ?? 1, items: membership[id] ?? [] }))
        ).slice(0, count);
        groupMembership = Object.fromEntries(
          Object.entries(membership).map(([id, items]) => [id, items.map((i) => i.id)])
        );
      } else {
        selected = shuffle(pool).slice(0, count);
      }

      const questions: ExpressionRecallQuestion[] = selected.map((expr) => ({
        expressionId: expr.id,
        prompt: promptFor(expr, direction),
      }));

      const session: ExpressionRecallSession = {
        sessionId: language,
        language,
        startedAt: new Date().toISOString(),
        status: "in-progress",
        reviewedQuestionCount: 0,
        score: { correct: 0, total: questions.length },
        questions,
        direction,
        ...(purposeFilter && purposeFilter.length > 0 ? { purposeFilter } : {}),
        ...(groupIds && groupIds.length > 0 ? { groupFilter: groupIds } : {}),
        ...(groupWeights ? { groupWeights } : {}),
        ...(groupMembership ? { groupMembership } : {}),
      };

      await saveExpressionRecallSession(session);
      return reply.status(201).send(session);
    }
  );

  // POST /answer — self-graded, no LLM.
  fastify.post<{
    Body: { language: string; expressionId: string; correct: boolean };
  }>(
    "/answer",
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

      const session = await getExpressionRecallSession(language);
      if (!session) return reply.notFound("No expression recall session found");
      if (session.status === "completed") return reply.badRequest("Session already completed");

      const question = session.questions.find(
        (q) => q.expressionId === expressionId && q.userCorrect === undefined
      );
      if (!question) return reply.notFound("Question not found in session");

      question.userCorrect = correct;
      if (correct) {
        session.score.correct++;
      } else {
        // Retries are APPENDED here, matching the grammar quiz — the word and
        // combined quizzes splice into the tail instead. `utils/quizLocal.ts`
        // mirrors whichever one applies, so the two must not drift.
        session.questions.push({ expressionId, prompt: question.prompt });
        session.score.total++;
      }

      const allAnswered = session.questions.every((q) => q.userCorrect !== undefined);
      if (allAnswered) {
        session.status = "completed";
        session.completedAt = new Date().toISOString();
      }

      await saveExpressionRecallSession(session);
      return { session };
    }
  );

  // GET /session/language/:language — resume, re-drawing the unanswered tail.
  fastify.get<{ Params: { language: string } }>(
    "/session/language/:language",
    async (request, reply) => {
      const session = await getExpressionRecallSession(request.params.language);
      if (!session) return reply.notFound("No expression recall session found");

      const answered: ExpressionRecallQuestion[] = [];
      const unanswered: ExpressionRecallQuestion[] = [];
      for (const q of session.questions) {
        if (q.userCorrect !== undefined) answered.push(q);
        else unanswered.push(q);
      }
      session.questions = [...answered, ...reweightUnanswered(unanswered, session)];
      await saveExpressionRecallSession(session);

      return session;
    }
  );

  fastify.put<{ Params: { language: string }; Body: { startedAt: string } }>(
    "/session/language/:language/reviewed",
    async (request, reply) => {
      const session = await getExpressionRecallSession(request.params.language);
      if (!session) return reply.notFound("No expression recall session found");
      if (session.startedAt !== request.body.startedAt) {
        return reply.conflict("The quiz session has been replaced");
      }
      session.reviewedQuestionCount = session.questions.filter(
        (q) => q.userCorrect !== undefined
      ).length;
      await saveExpressionRecallSession(session);
      return { reviewedQuestionCount: session.reviewedQuestionCount };
    }
  );

  fastify.delete<{ Params: { language: string } }>(
    "/session/language/:language",
    async (request, reply) => {
      const deleted = await deleteExpressionRecallSession(request.params.language);
      if (!deleted) return reply.notFound("No expression recall session found");
      return { deleted: true };
    }
  );
};

export default expressionRecallQuizRoutes;
