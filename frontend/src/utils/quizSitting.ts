/** Mirrored between backend quiz-sitting.ts and frontend utils/quizSitting.ts. */
interface SittingQuestion {
  kind?: string;
  wordId?: string;
  grammarId?: string;
  expressionId?: string;
  userCorrect?: boolean;
}
interface SittingSession {
  questions: SittingQuestion[];
  reviewedQuestionCount?: number;
  status: string;
  completedAt?: string;
  score: { correct: number; total: number };
  mixedScope?: object;
  wordGroupMembership?: Record<string, string[]>;
  grammarGroupMembership?: Record<string, string[]>;
}
const key = (q: SittingQuestion) => q.wordId !== undefined ? `word:${q.wordId}`
  : q.grammarId !== undefined ? `grammar:${q.grammarId}` : `expression:${q.expressionId}`;

/** Lazily remove old retry copies belonging to the current sitting. Keep all history. */
export function normalizeQuizSitting<S extends SittingSession>(original: S): S {
  const answered = original.questions.filter(q => q.userCorrect !== undefined);
  const seen = new Set(answered.slice(original.reviewedQuestionCount ?? 0).map(key));
  const questions = original.questions.filter(q => {
    if (q.userCorrect !== undefined) return true;
    const id = key(q);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const session = {
    ...original, questions,
    reviewedQuestionCount: original.reviewedQuestionCount ?? answered.length,
    score: { ...original.score, total: questions.length },
  } as S;
  if (questions.every(q => q.userCorrect !== undefined)) {
    session.status = "completed";
    session.completedAt ??= new Date().toISOString();
  }
  return session;
}

/** Advance the durable sitting boundary. Wrong items return only when the quiz continues.
 * Repeating this operation without new answers is idempotent (outbox network retries).
 */
export function finishQuizSitting<S extends SittingSession>(original: S): S {
  const session = normalizeQuizSitting(original);
  const answered = session.questions.filter(q => q.userCorrect !== undefined);
  const pending = session.questions.filter(q => q.userCorrect === undefined);
  if (session.status !== "completed" && pending.length > 0) {
    const seen = new Set(pending.map(key));
    const latest = new Map(answered.slice(session.reviewedQuestionCount ?? answered.length).map(q => [key(q), q]));
    for (const q of latest.values()) {
      if (session.mixedScope) {
        const membership = q.wordId !== undefined ? session.wordGroupMembership : session.grammarGroupMembership;
        const id = q.wordId ?? q.grammarId!;
        if (!Object.values(membership ?? {}).some(ids => ids.includes(id))) continue;
      }
      if (q.userCorrect !== false || seen.has(key(q))) continue;
      seen.add(key(q));
      const retry = { ...q };
      delete retry.userCorrect;
      pending.push(retry);
    }
  }
  return {
    ...session,
    questions: [...answered, ...pending],
    reviewedQuestionCount: answered.length,
    score: { ...session.score, total: answered.length + pending.length },
  } as S;
}
