/**
 * Client-side mirror of what the backend does to a session when an answer arrives.
 *
 * Grading used to block on `POST /answer` and only advance once the server's updated session
 * came back — which meant a weak connection froze the quiz on the current card. Now the client
 * applies the same mutation locally, advances immediately, and hands the write to the outbox
 * (`utils/answerOutbox.ts`) to land whenever the network allows.
 *
 * The two sides therefore compute the retry position independently and their question ORDER
 * diverges while offline. That is deliberate and harmless: every resume path re-draws the
 * unanswered tail from the stored group weights, so the server's order is never the one the
 * user ends up seeing.
 *
 * Everything here is pure — it returns new objects and never touches its arguments.
 */

import type {
  CombinedQuizQuestion,
  CombinedQuizSession,
  ExpressionRecallQuestion,
  ExpressionRecallSession,
  GrammarQuizQuestion,
  GrammarQuizSession,
  QuizQuestion,
  QuizSession,
} from "../types";

/**
 * Port of `backend/src/quiz-utils.ts:insertRetryQuestion`. Splices the retry copy at a random
 * spot in the remaining tail rather than reshuffling it, so a weighted (grouped) ordering
 * survives the insert. Mutates the array it is given, like its server twin.
 */
function insertRetryQuestion<T>(questions: T[], retryQuestion: T, answeredIndex: number): void {
  const tailStart = answeredIndex + 1;
  const tailLen = questions.length - tailStart;
  const pos = tailStart + Math.floor(Math.random() * (tailLen + 1));
  questions.splice(pos, 0, retryQuestion);
}

/** The answered question is the first one with this id that has no answer yet — the same
 *  rule `routes/quiz.ts` uses, so client and server agree on which slot an answer fills. */
function firstUnansweredIndex<T extends { userCorrect?: boolean }>(
  questions: T[],
  matches: (q: T) => boolean
): number {
  return questions.findIndex((q) => q.userCorrect === undefined && matches(q));
}

// ---------- word quiz ----------

export function applyWordAnswerLocally(
  session: QuizSession,
  wordId: string,
  correct: boolean
): QuizSession {
  const questions = session.questions.map((q) => ({ ...q }));
  const index = firstUnansweredIndex(questions, (q) => q.wordId === wordId);
  if (index === -1) return session;

  questions[index].userCorrect = correct;
  const score = {
    correct: session.score.correct + (correct ? 1 : 0),
    total: session.score.total,
  };

  if (!correct) {
    // Wrong answers are asked again later, so the denominator grows — matching `routes/quiz.ts`.
    const retry: QuizQuestion = { ...questions[index] };
    delete retry.userCorrect;
    insertRetryQuestion(questions, retry, index);
    score.total += 1;
  }

  return {
    ...session,
    questions,
    score,
    // A missed item is no longer "already correct": drop it so a later reweight treats it as fresh.
    ...(correct ? {} : { correctMembership: session.correctMembership?.filter((id) => id !== wordId) }),
    ...(questions.every((q) => q.userCorrect !== undefined)
      ? { status: "completed" as const, completedAt: new Date().toISOString() }
      : {}),
  };
}

// ---------- grammar quiz ----------

export function applyGrammarAnswerLocally(
  session: GrammarQuizSession,
  grammarId: string,
  correct: boolean
): GrammarQuizSession {
  const questions = session.questions.map((q) => ({ ...q }));
  const index = firstUnansweredIndex(questions, (q) => q.grammarId === grammarId);
  if (index === -1) return session;

  questions[index].userCorrect = correct;
  const score = {
    correct: session.score.correct + (correct ? 1 : 0),
    total: session.score.total,
  };

  if (!correct) {
    // NOTE: the grammar quiz APPENDS its retry rather than splicing it into the tail
    // (`routes/grammar-quiz.ts`). Kept deliberately different so local and server agree.
    const retry: GrammarQuizQuestion = { ...questions[index] };
    delete retry.userCorrect;
    questions.push(retry);
    score.total += 1;
  }

  return {
    ...session,
    questions,
    score,
    ...(correct
      ? {}
      : { correctMembership: session.correctMembership?.filter((id) => id !== grammarId) }),
    ...(questions.every((q) => q.userCorrect !== undefined)
      ? { status: "completed" as const, completedAt: new Date().toISOString() }
      : {}),
  };
}

// ---------- combined (Group A / Group B) quiz ----------

export function applyCombinedAnswerLocally(
  session: CombinedQuizSession,
  kind: "word" | "grammar",
  refId: string,
  correct: boolean
): CombinedQuizSession {
  const questions = session.questions.map((q) => ({ ...q })) as CombinedQuizQuestion[];
  const index = firstUnansweredIndex(questions, (q) =>
    q.kind === "word" ? kind === "word" && q.wordId === refId : kind === "grammar" && q.grammarId === refId
  );
  if (index === -1) return session;

  questions[index].userCorrect = correct;
  const score = {
    correct: session.score.correct + (correct ? 1 : 0),
    total: session.score.total,
  };

  if (!correct) {
    const retry = { ...questions[index] } as CombinedQuizQuestion;
    delete retry.userCorrect;
    insertRetryQuestion(questions, retry, index);
    score.total += 1;
  }

  const membership = session.correctMembership;
  return {
    ...session,
    questions,
    score,
    ...(correct || !membership
      ? {}
      : {
          correctMembership: {
            wordIds: kind === "word" ? membership.wordIds.filter((id) => id !== refId) : membership.wordIds,
            grammarIds:
              kind === "grammar"
                ? membership.grammarIds.filter((id) => id !== refId)
                : membership.grammarIds,
          },
        }),
    ...(questions.every((q) => q.userCorrect !== undefined)
      ? { status: "completed" as const, completedAt: new Date().toISOString() }
      : {}),
  };
}

// ---------- expression recall quiz ----------

export function applyExpressionRecallAnswerLocally(
  session: ExpressionRecallSession,
  expressionId: string,
  correct: boolean
): ExpressionRecallSession {
  const questions = session.questions.map((q) => ({ ...q }));
  const index = firstUnansweredIndex(questions, (q) => q.expressionId === expressionId);
  if (index === -1) return session;

  questions[index].userCorrect = correct;
  const score = {
    correct: session.score.correct + (correct ? 1 : 0),
    total: session.score.total,
  };

  if (!correct) {
    // APPENDS, like the grammar quiz (`routes/expression-recall-quiz.ts` does the
    // same) — the word and combined quizzes splice into the tail instead. The two
    // sides must agree on which.
    const retry: ExpressionRecallQuestion = { ...questions[index] };
    delete retry.userCorrect;
    questions.push(retry);
    score.total += 1;
  }

  return {
    ...session,
    questions,
    score,
    ...(questions.every((q) => q.userCorrect !== undefined)
      ? { status: "completed" as const, completedAt: new Date().toISOString() }
      : {}),
  };
}
