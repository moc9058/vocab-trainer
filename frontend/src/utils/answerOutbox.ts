/**
 * Outbound queue for quiz answers.
 *
 * Grading is local-first (see `utils/quizLocal.ts`): the UI advances immediately and the write
 * lands here, so a weak or dead connection never blocks the quiz. The queue drains in the
 * background and retries until the network comes back.
 *
 * MODULE-LEVEL, not component state — the same reason `useWordQueue`/`useGrammarQueue` keep
 * their lock at module scope. Navigating home unmounts the quiz component, and pending answers
 * must survive that; they only die with the page itself, which is what the `beforeunload`
 * guard in the quiz screens warns about.
 *
 * STRICTLY SERIAL, in enqueue order. The backend fills "the first question with this id and no
 * answer yet", so when a word is answered and then answered again as a retry copy, the two
 * writes must arrive in that order or they land in the wrong slots.
 *
 * Non-answer session mutations (the mixed quiz's membership refile and End Session review
 * boundaries) ride the same queue precisely because it is serial: they and POST /answer all
 * read-modify-write the session document, so letting them race would lose whichever wrote first.
 */

import { ApiError, putJson, isRetryableError } from "../api/client";
import { answerQuestion, markQuizReviewComplete } from "../api/quiz";
import {
  answerCombinedQuestion,
  removeMixedQuestionFromB,
  markCombinedQuizReviewComplete,
  updateCombinedQuizWeights,
  type CombinedQuizVariant,
} from "../api/combined-quiz";
import { answerGrammarQuestion, markGrammarQuizReviewComplete } from "../api/grammar";
import {
  answerExpressionRecallQuestion,
  markExpressionRecallReviewComplete,
} from "../api/expression-recall-quiz";

export interface ReviewOperation {
  action: "start" | "next";
  startedAt: string;
  reviewId: string;
  operationId: string;
  revision: number;
  fromAnsweredCount: number;
}

export type PendingAnswer =
  | { domain: "math"; execute: () => Promise<unknown>; rebase: () => Promise<void>; resolve: (result: unknown) => void; reject: (error: unknown) => void; onDiscard?: () => void }
  | { domain: "review"; path: string; operation: ReviewOperation;
      resolve: (result: unknown) => void; reject: (error: unknown) => void }
  | {
      domain: "word";
      sessionId: string;
      wordId: string;
      correct: boolean;
      flagWordIds?: string[];
    }
  | {
      domain: "grammar";
      language: string;
      grammarId: string;
      correct: boolean;
    }
  | {
      domain: "combined";
      language: string;
      variant: CombinedQuizVariant;
      kind: "word" | "grammar";
      refId: string;
      correct: boolean;
      removeFromGroupB?: boolean;
      startedAt?: string;
      operationId?: string;
      flagWordIds?: string[];
    }
  | { domain: "combinedRemoval"; language: string; kind: "word" | "grammar"; refId: string; startedAt: string; operationId: string }
  | {
      domain: "expressionRecall";
      language: string;
      expressionId: string;
      correct: boolean;
    }
  | { domain: "wordReviewComplete"; language: string; startedAt: string }
  | { domain: "grammarReviewComplete"; language: string; startedAt: string }
  | {
      domain: "combinedReviewComplete";
      language: string;
      startedAt: string;
      variant: CombinedQuizVariant;
    }
  | { domain: "expressionRecallReviewComplete"; language: string; startedAt: string }
  | {
      /** Mixed-quiz membership refile — a PUT …/weights carrying only membership maps.
       *  FULL-STATE payload captured at enqueue time: a later entry restates all earlier
       *  moves, so a dropped (non-retryable) or superseded entry loses nothing. The
       *  response is discarded — local state was already updated when this was enqueued. */
      domain: "combinedMembership";
      language: string;
      variant: CombinedQuizVariant;
      wordGroupMembership?: Record<string, string[]>;
      grammarGroupMembership?: Record<string, string[]>;
    };

export interface OutboxState {
  /** Answers still waiting to reach the server. */
  pending: number;
  /** Answers the server rejected outright; retrying cannot help, so they were dropped. */
  failed: number;
  /** True while a flush attempt is in flight or a backoff timer is armed. */
  syncing: boolean;
  authBlocked: boolean;
  conflictBlocked: boolean;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

const queue: PendingAnswer[] = [];
let failed = 0;
let syncing = false;
let authBlocked = false;
let conflictBlocked = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(state: OutboxState) => void>();

/**
 * Cached because `useSyncExternalStore` compares snapshots by identity — returning a freshly
 * built object each call would make React see a change on every render and loop forever. A new
 * object is minted only when a field actually differs.
 */
let snapshotCache: OutboxState = { pending: 0, failed: 0, syncing: false, authBlocked: false, conflictBlocked: false };

function refreshSnapshot(): void {
  const pending = queue.length;
  const isSyncing = syncing || timer !== null;
  if (
    snapshotCache.pending !== pending ||
    snapshotCache.failed !== failed ||
    snapshotCache.syncing !== isSyncing || snapshotCache.authBlocked !== authBlocked || snapshotCache.conflictBlocked !== conflictBlocked
  ) {
    snapshotCache = { pending, failed, syncing: isSyncing, authBlocked, conflictBlocked };
  }
}

function emit(): void {
  refreshSnapshot();
  for (const listener of listeners) listener(snapshotCache);
}

function send(item: PendingAnswer): Promise<unknown> {
  switch (item.domain) {
    case "math": return item.execute();
    case "review":
      if (failed > 0) return Promise.reject(new ApiError(409, "Some earlier answers could not be saved"));
      return putJson(item.path, item.operation);
    case "word":
      return answerQuestion({
        sessionId: item.sessionId,
        wordId: item.wordId,
        correct: item.correct,
        ...(item.flagWordIds?.length ? { flagWordIds: item.flagWordIds } : {}),
      });
    case "grammar":
      return answerGrammarQuestion({
        language: item.language,
        grammarId: item.grammarId,
        correct: item.correct,
      });
    case "combined":
      return answerCombinedQuestion(
        {
          language: item.language,
          kind: item.kind,
          refId: item.refId,
          correct: item.correct,
          removeFromGroupB: item.removeFromGroupB,
          startedAt: item.startedAt,
          operationId: item.operationId,
          ...(item.flagWordIds?.length ? { flagWordIds: item.flagWordIds } : {}),
        },
        item.variant
      );
    case "combinedRemoval":
      return removeMixedQuestionFromB(item);
    case "expressionRecall":
      return answerExpressionRecallQuestion({
        language: item.language,
        expressionId: item.expressionId,
        correct: item.correct,
      });
    case "wordReviewComplete":
      return markQuizReviewComplete(item.language, item.startedAt);
    case "grammarReviewComplete":
      return markGrammarQuizReviewComplete(item.language, item.startedAt);
    case "combinedReviewComplete":
      return markCombinedQuizReviewComplete(item.language, item.startedAt, item.variant);
    case "expressionRecallReviewComplete":
      return markExpressionRecallReviewComplete(item.language, item.startedAt);
    case "combinedMembership":
      return updateCombinedQuizWeights(
        item.language,
        {
          ...(item.wordGroupMembership ? { wordGroupMembership: item.wordGroupMembership } : {}),
          ...(item.grammarGroupMembership
            ? { grammarGroupMembership: item.grammarGroupMembership }
            : {}),
        },
        item.variant
      );
  }
}

/** Arms the backoff retry. Clears any existing timer first so only ever one is pending. */
function scheduleRetry(): void {
  if (timer !== null) clearTimeout(timer);
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt += 1;
  timer = setTimeout(() => {
    timer = null;
    void drain();
  }, delay);
}

async function drain(): Promise<void> {
  if (syncing || authBlocked || conflictBlocked) return;
  syncing = true;
  emit();

  while (queue.length > 0) {
    const item = queue[0];
    try {
      const result = await send(item);
      if (item.domain === "review" || item.domain === "math") item.resolve(result);
      queue.shift();
      attempt = 0;
      emit();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        authBlocked = true; syncing = false; emit(); return;
      }
      if (isRetryableError(err)) {
        // Offline / server trouble: keep the item at the head and come back to it. Waiting is
        // the whole point — the user may well finish the quiz before the connection returns.
        syncing = false;
        scheduleRetry();
        emit();
        return;
      }
      if (item.domain === "math") {
        conflictBlocked = true; syncing = false; emit(); return;
      }
      // A permanent refusal affects THIS answer. Authentication failures above keep the queue.
      // Drop permanent failures so one bad write cannot wedge
      // every answer behind it.
      console.error("Dropping unsyncable quiz answer", item, err);
      queue.shift();
      if (item.domain === "review") item.reject(err);
      else failed += 1;
      attempt = 0;
      emit();
    }
  }

  syncing = false;
  emit();
}

/** Queue one answer and start draining. Never throws and never blocks the caller. */
export function enqueueAnswer(item: PendingAnswer): void {
  queue.push(item);
  emit();
  // Only kick a drain when no backoff is pending. Otherwise every card graded while offline
  // would fire its own doomed request AND arm another timer, defeating the backoff and
  // leaving orphaned timers whose handles no longer match `timer`.
  if (timer === null) void drain();
}

/** Retry now — used by the reconnect listener and the badge's manual retry. */
export function flushAnswers(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  attempt = 0;
  void drain();
}

/** Clears the "N answers could not be synced" counter once the user has seen it. */
export function acknowledgeFailedAnswers(): void {
  failed = 0;
  emit();
}

export function getOutboxState(): OutboxState {
  return snapshotCache;
}

export function subscribeToOutbox(listener: (state: OutboxState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  // The browser telling us the radio is back is a far better trigger than the next backoff tick.
  window.addEventListener("online", () => flushAnswers());
}

/** Review requests use the answer queue, and expose their confirmed session to the UI. */
export function enqueueReviewOperation<S>(path: string, operation: ReviewOperation): Promise<{ session: S }> {
  return new Promise((resolve, reject) => enqueueAnswer({ domain: "review", path, operation,
    resolve: result => resolve(result as { session: S }), reject }));
}

/** Only a confirmed /me success may release an authentication pause. */
export function resumeAnswers(): void { authBlocked = false; flushAnswers(); emit(); }
export function discardAnswers(): void {
  // Called only after explicit logout confirmation. Do not discard an in-flight head.
  if (syncing) throw new Error("Wait for the current answer to finish before signing out");
  if (timer !== null) { clearTimeout(timer); timer = null; }
  for (const item of queue) if (item.domain === "review" || item.domain === "math") item.reject(new ApiError(401, "Signed out"));
  for (const item of queue) if (item.domain === "math") item.onDiscard?.();
  queue.length = 0; failed = 0; authBlocked = false; conflictBlocked = false; emit();
}
export type FlushResult = "synced" | "auth" | "failed" | "pending";
export function waitForAnswers(timeoutMs = 15_000): Promise<FlushResult> {
  return new Promise(resolve => {
    const result = (s: OutboxState): FlushResult | null => s.authBlocked ? "auth" : s.failed ? "failed" : s.pending === 0 ? "synced" : null;
    const initial = result(getOutboxState()); if (initial) { resolve(initial); return; }
    const timer = setTimeout(() => { unsubscribe(); resolve("pending"); }, timeoutMs);
    const unsubscribe = subscribeToOutbox(state => { const done = result(state); if (done) { clearTimeout(timer); unsubscribe(); resolve(done); } });
  });
}

/** Retain mathematics requests on conflict until the learner explicitly resolves them. */
export async function resolveMathConflict(retry: boolean): Promise<void> {
  const item = queue[0]; if (!conflictBlocked || item?.domain !== "math") return;
  if (retry) await item.rebase();
  else { queue.shift(); item.onDiscard?.(); item.reject(new ApiError(409, "Local operation discarded")); }
  conflictBlocked = false; flushAnswers(); emit();
}
