import type { FastifyInstance } from "fastify";
import type { QuizReviewState } from "./types.js";
import { finishQuizSitting } from "./quiz-sitting.js";
import { shuffle } from "./quiz-utils.js";

interface ReviewSession {
  startedAt: string;
  questions: { userCorrect?: boolean; wordId?: string; grammarId?: string; expressionId?: string }[];
  reviewedQuestionCount?: number;
  reviewState?: QuizReviewState;
  status: string;
  score: { correct: number; total: number };
}

export interface ReviewOperation {
  action: "start" | "next";
  startedAt: string;
  reviewId: string;
  operationId: string;
  revision: number;
  fromAnsweredCount: number;
}

export class QuizReviewError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

/** Answered attempts retain their relative order through tail reorders and live B updates.
 * Each new review persists a shuffled permutation of offsets into that fixed range.
 * The cursor addresses that order, not a word ID (one item can have several attempts).
 * Only final progress advances the sitting boundary and releases retries. */
export function applyReviewOperation<S extends ReviewSession>(session: S, input: ReviewOperation): S {
  const conflict = (message: string): never => { throw new QuizReviewError(409, message); };
  if (session.startedAt !== input.startedAt) conflict("The quiz session has been replaced");
  const state = session.reviewState;
  if (input.action === "start") {
    if (state?.reviewId === input.reviewId) return session;
    if (state?.status === "active") conflict("Another review is already active");
    const answered = session.questions.filter(q => q.userCorrect !== undefined).length;
    const from = session.reviewedQuestionCount ?? answered;
    if (input.fromAnsweredCount !== from || input.revision !== 0) conflict("The review boundary has changed");
    if (answered <= from) conflict("No answers to review");
    return { ...session, reviewState: {
      reviewId: input.reviewId, status: "active", fromAnsweredCount: from,
      toAnsweredCount: answered, cursor: 0, revision: 0, lastOperationId: input.operationId,
      questionOrder: shuffle(Array.from({ length: answered - from }, (_, index) => index)),
    } };
  }
  if (!state || state.reviewId !== input.reviewId) return conflict("The review has been replaced");
  if (state.lastOperationId === input.operationId) return session;
  if (state.status !== "active" || state.revision !== input.revision ||
      state.fromAnsweredCount !== input.fromAnsweredCount) conflict("The review has changed on another screen");
  const next: QuizReviewState = { ...state, cursor: state.cursor + 1,
    revision: state.revision + 1, lastOperationId: input.operationId };
  if (next.cursor < next.toAnsweredCount - next.fromAnsweredCount) return { ...session, reviewState: next };
  next.status = "completed";
  return { ...finishQuizSitting(session), reviewState: next };
}

/** Register inside each existing quiz plugin, using its own transactional store and key. */
export function registerQuizReviewRoutes<S extends ReviewSession>(
  fastify: FastifyInstance,
  mutate: (language: string, fn: (session: S | null) => Promise<S>) => Promise<S>,
  afterFinish?: (session: S) => S,
): void {
  fastify.put<{ Params: { language: string }; Body: ReviewOperation }>(
    "/session/language/:language/review", {
      schema: { body: {
        type: "object", additionalProperties: false,
        required: ["action", "startedAt", "reviewId", "operationId", "revision", "fromAnsweredCount"],
        properties: {
          action: { type: "string", enum: ["start", "next"] },
          startedAt: { type: "string", minLength: 1 },
          reviewId: { type: "string", minLength: 1, maxLength: 128 },
          operationId: { type: "string", minLength: 1, maxLength: 128 },
          revision: { type: "integer", minimum: 0 },
          fromAnsweredCount: { type: "integer", minimum: 0 },
        },
      } },
    }, async request => ({ session: await mutate(request.params.language, async session => {
      if (!session) throw fastify.httpErrors.notFound("No quiz session found");
      const wasActive = session.reviewState?.status === "active";
      Object.assign(session, applyReviewOperation(session, request.body));
      if (wasActive && session.reviewState?.status === "completed" && afterFinish) Object.assign(session, afterFinish(session));
      return session;
    }) }),
  );
}

/** Old clients cannot skip an active review or advance a subsequent sitting by replay. */
export function assertLegacyReviewAllowed(session: ReviewSession): boolean {
  if (session.reviewState?.status === "active") throw new QuizReviewError(409, "Finish the active review first");
  return !session.reviewState;
}
