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
 * Besides answers, this file also mirrors the mixed quiz's Group B → A refile: moving an
 * item's session bucket after a remove-from-Group-B (`refileCombinedMembership`) and the
 * weighted tail re-draw that makes the move visible (`reorderCombinedTailLocally`).
 *
 * Everything here is pure — it returns new objects and never touches its arguments.
 */

import type {
  CombinedQuizGrammarQuestion,
  CombinedQuizQuestion,
  CombinedQuizSession,
  CombinedQuizWordQuestion,
  ExpressionRecallQuestion,
  ExpressionRecallSession,
  GrammarQuizQuestion,
  GrammarQuizSession,
  GroupCategory,
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

// ---------- combined quiz: Group B → A refile (mixed variant) ----------

// Ports of `backend/src/quiz-utils.ts` — deliberately copied, like `insertRetryQuestion`
// above, so the local tail re-draw orders questions by the same rules as the server.

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
  }
  return shuffled;
}

function weightedMerge<T>(buckets: { weight: number; items: T[] }[]): T[] {
  const pools = buckets
    .filter((b) => b.weight > 0 && b.items.length > 0)
    .map((b) => ({ weight: b.weight, items: [...b.items] }));
  const order: T[] = [];
  while (pools.some((p) => p.items.length > 0)) {
    const active = pools.filter((p) => p.items.length > 0);
    const total = active.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * total;
    let chosen = active[active.length - 1];
    for (const p of active) {
      r -= p.weight;
      if (r <= 0) {
        chosen = p;
        break;
      }
    }
    order.push(chosen.items.shift()!);
  }
  return order;
}

function weightedInterleave<T>(buckets: { weight: number; items: T[] }[]): T[] {
  return weightedMerge(buckets.map((b) => ({ weight: b.weight, items: shuffle(b.items) })));
}

export interface RefileOpts {
  /** groupId → category from the groups fetch; undefined when the fetch failed or the
   *  group has been deleted since — such keys are simply not treated as B. */
  categoryOfGroup: (groupId: string) => GroupCategory | undefined;
  /** The B-group ids the server's DELETE actually removed the item from — authoritative
   *  even when `categoryOfGroup` knows nothing. */
  removedFromGroupIds: string[];
  /** The item's category-A home, or undefined → strip-only (the item then falls to the
   *  re-draw's unweighted tail-append, like any uncovered question). */
  aGroupId: string | undefined;
}

/**
 * Move one item's session bucket out of Group B and into its Group A home after a
 * remove-from-Group-B — the local half of the mixed quiz's refile (the server half is the
 * wholesale membership replacement on PUT …/weights). Only the given domain's map changes;
 * emptied B keys are kept as `[]` (the server keeps them too, and the ⚖ panel iterates
 * keys). Pure and IDEMPOTENT — `refileAfterRemoval` applies it both to the flushed state
 * (for the outbox payload) and inside a React state updater, and the two must agree.
 */
export function refileCombinedMembership(
  session: CombinedQuizSession,
  kind: "word" | "grammar",
  refId: string,
  opts: RefileOpts
): CombinedQuizSession {
  const map = kind === "word" ? session.wordGroupMembership : session.grammarGroupMembership;
  if (!map || Object.keys(map).length === 0) return session;

  const strip = new Set(opts.removedFromGroupIds);
  for (const gid of Object.keys(map)) {
    if (opts.categoryOfGroup(gid) === "B") strip.add(gid);
  }

  const next: Record<string, string[]> = {};
  for (const [gid, ids] of Object.entries(map)) {
    next[gid] = strip.has(gid) ? ids.filter((id) => id !== refId) : [...ids];
  }
  // `strip.has` guards a home that is somehow also a removal target — never append there.
  if (opts.aGroupId && !strip.has(opts.aGroupId)) {
    const home = next[opts.aGroupId] ?? []; // creates the key when the A group wasn't selected at /start
    next[opts.aGroupId] = home.includes(refId) ? home : [...home, refId];
  }

  return {
    ...session,
    ...(kind === "word" ? { wordGroupMembership: next } : { grammarGroupMembership: next }),
  };
}

/** Port of the server's `reweightDomain`: order one domain's tail by its stored
 *  membership/weights, appending anything not covered (retry duplicates included). */
function reweightDomainLocally<T extends object>(
  unanswered: T[],
  membership: Record<string, string[]> | undefined,
  weights: Record<string, number> | undefined,
  idOf: (q: T) => string
): T[] {
  if (!membership || Object.keys(membership).length === 0) {
    return shuffle(unanswered);
  }
  const byId = new Map<string, T>();
  for (const q of unanswered) byId.set(idOf(q), q);
  const buckets = Object.entries(membership).map(([gid, ids]) => ({
    weight: weights?.[gid] ?? 1,
    items: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
  }));
  const ordered = weightedInterleave(buckets);
  const covered = new Set(ordered);
  for (const q of unanswered) {
    if (!covered.has(q)) ordered.push(q);
  }
  return ordered;
}

/**
 * Client port of `routes/combined-quiz.ts:reorderUnansweredTail`, with ONE deliberate
 * difference: the first unanswered question — the card on screen — is PINNED at its index
 * and only the tail behind it is re-drawn, so a refile can never swap the card mid-read.
 * The answered prefix and the question count are unchanged, so the caller's index into
 * `questions` stays valid. A `randomOrder` session is returned untouched (mirrors the
 * server's refusal to re-weight it; also makes accidental use on one a no-op).
 */
export function reorderCombinedTailLocally(session: CombinedQuizSession): CombinedQuizSession {
  if (session.randomOrder) return session;

  const answered: CombinedQuizQuestion[] = [];
  const unanswered: CombinedQuizQuestion[] = [];
  for (const q of session.questions) {
    if (q.userCorrect !== undefined) answered.push(q);
    else unanswered.push(q);
  }
  if (unanswered.length <= 1) return session;

  const [pinned, ...rest] = unanswered;

  const useCorrect = session.correctWeight !== undefined;
  const knownWordIds = new Set(session.correctMembership?.wordIds ?? []);
  const knownGrammarIds = new Set(session.correctMembership?.grammarIds ?? []);
  const isKnown = (q: CombinedQuizQuestion): boolean =>
    q.kind === "word" ? knownWordIds.has(q.wordId) : knownGrammarIds.has(q.grammarId);
  const fresh = useCorrect ? rest.filter((q) => !isKnown(q)) : rest;

  const wordTail = reweightDomainLocally(
    fresh.filter((q): q is CombinedQuizWordQuestion => q.kind === "word"),
    session.wordGroupMembership,
    session.wordGroupWeights,
    (q) => q.wordId
  );
  const grammarTail = reweightDomainLocally(
    fresh.filter((q): q is CombinedQuizGrammarQuestion => q.kind === "grammar"),
    session.grammarGroupMembership,
    session.grammarGroupWeights,
    (q) => q.grammarId
  );
  const merged = weightedMerge<CombinedQuizQuestion>([
    { weight: session.domainWeights?.word ?? 1, items: wordTail },
    { weight: session.domainWeights?.grammar ?? 1, items: grammarTail },
    ...(useCorrect
      ? [{ weight: session.correctWeight ?? 0, items: shuffle(rest.filter(isKnown)) }]
      : []),
  ]);
  // weightedMerge drops zero-weight buckets; never lose questions.
  const covered = new Set(merged);
  for (const q of rest) {
    if (!covered.has(q)) merged.push(q);
  }
  return { ...session, questions: [...answered, pinned, ...merged] };
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
