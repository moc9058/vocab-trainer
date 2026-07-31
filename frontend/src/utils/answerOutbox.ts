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
 */

import { isRetryableError } from "../api/client";
import { answerQuestion } from "../api/quiz";
import { answerCombinedQuestion, type CombinedQuizVariant } from "../api/combined-quiz";
import { answerGrammarQuestion } from "../api/grammar";
import { answerExpressionRecallQuestion } from "../api/expression-recall-quiz";

export type PendingAnswer =
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
      flagWordIds?: string[];
    }
  | {
      domain: "expressionRecall";
      language: string;
      expressionId: string;
      correct: boolean;
    };

export interface OutboxState {
  /** Answers still waiting to reach the server. */
  pending: number;
  /** Answers the server rejected outright; retrying cannot help, so they were dropped. */
  failed: number;
  /** True while a flush attempt is in flight or a backoff timer is armed. */
  syncing: boolean;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

const queue: PendingAnswer[] = [];
let failed = 0;
let syncing = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(state: OutboxState) => void>();

/**
 * Cached because `useSyncExternalStore` compares snapshots by identity — returning a freshly
 * built object each call would make React see a change on every render and loop forever. A new
 * object is minted only when a field actually differs.
 */
let snapshotCache: OutboxState = { pending: 0, failed: 0, syncing: false };

function refreshSnapshot(): void {
  const pending = queue.length;
  const isSyncing = syncing || timer !== null;
  if (
    snapshotCache.pending !== pending ||
    snapshotCache.failed !== failed ||
    snapshotCache.syncing !== isSyncing
  ) {
    snapshotCache = { pending, failed, syncing: isSyncing };
  }
}

function emit(): void {
  refreshSnapshot();
  for (const listener of listeners) listener(snapshotCache);
}

function send(item: PendingAnswer): Promise<unknown> {
  switch (item.domain) {
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
          ...(item.flagWordIds?.length ? { flagWordIds: item.flagWordIds } : {}),
        },
        item.variant
      );
    case "expressionRecall":
      return answerExpressionRecallQuestion({
        language: item.language,
        expressionId: item.expressionId,
        correct: item.correct,
      });
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
  if (syncing) return;
  syncing = true;
  emit();

  while (queue.length > 0) {
    const item = queue[0];
    try {
      await send(item);
      queue.shift();
      attempt = 0;
      emit();
    } catch (err) {
      if (isRetryableError(err)) {
        // Offline / server trouble: keep the item at the head and come back to it. Waiting is
        // the whole point — the user may well finish the quiz before the connection returns.
        syncing = false;
        scheduleRetry();
        emit();
        return;
      }
      // A 4xx that isn't worth retrying: the server refused THIS answer (a 401 has already
      // been announced centrally by the API client). Drop it so one bad write can't wedge
      // every answer behind it.
      console.error("Dropping unsyncable quiz answer", item, err);
      queue.shift();
      failed += 1;
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
