/**
 * Durable log for the quiz launched by the “End Session” button.
 *
 * Quiz answers themselves are persisted by the backend, but the review boundary is a UI
 * concept: a user can review part of a still-running quiz, return later, and expect the next
 * review to contain only the answers made since then. Keeping that boundary in localStorage
 * also means a refresh does not reset the review to an empty, mount-local array.
 */

// v1 incorrectly recovered every historical answer when no local marker existed. A new prefix
// deliberately leaves those corrupted snapshots behind; the server-side review boundary is the
// only safe fallback now.
const PREFIX = "vocab-trainer:session-review:v2";

interface StoredReview<T> {
  startedAt: string;
  questions: T[];
}

export function sessionReviewKey(kind: string, sessionId: string): string {
  return `${PREFIX}:${encodeURIComponent(kind)}:${encodeURIComponent(sessionId)}`;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    // localStorage can be unavailable in privacy-restricted browser contexts. The caller still
    // gets a working in-memory React log for the current mount.
    return undefined;
  }
}

function readStored<T>(key: string, startedAt: string, storage: Storage | undefined): T[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredReview<T>>;
    if (parsed.startedAt !== startedAt || !Array.isArray(parsed.questions)) return null;
    return parsed.questions;
  } catch {
    return null;
  }
}

function writeStored<T>(
  key: string,
  startedAt: string,
  questions: T[],
  storage: Storage | undefined
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ startedAt, questions } satisfies StoredReview<T>));
  } catch {
    // A storage quota/privacy failure must never stop grading.
  }
}

/**
 * Restore the unreviewed attempts. `sessionQuestions` must already be sliced at the durable
 * server-side review boundary; blindly using every answered question here caused an End Session
 * review of two new attempts to resurrect hundreds of historical answers.
 * Persisting an empty array is significant: it records that all earlier answers were reviewed.
 */
export function loadSessionReview<T extends { userCorrect?: boolean }>(
  key: string,
  startedAt: string,
  sessionQuestions: T[],
  storage: Storage | undefined = browserStorage()
): T[] {
  const stored = readStored<T>(key, startedAt, storage);
  if (stored) return stored;

  const recovered = sessionQuestions.filter((q) => q.userCorrect !== undefined);
  writeStored(key, startedAt, recovered, storage);
  return recovered;
}

/**
 * Select attempts after the last completed End Session review. Legacy sessions have no boundary;
 * their existing answers predate this feature and are therefore considered already reviewed.
 */
export function unreviewedSessionQuestions<T extends { userCorrect?: boolean }>(
  questions: T[],
  reviewedQuestionCount: number | undefined
): T[] {
  const answered = questions.filter((q) => q.userCorrect !== undefined);
  const boundary = reviewedQuestionCount === undefined
    ? answered.length
    : Math.max(0, Math.min(reviewedQuestionCount, answered.length));
  return answered.slice(boundary);
}

export function appendSessionReview<T>(
  key: string,
  startedAt: string,
  current: T[],
  question: T,
  storage: Storage | undefined = browserStorage()
): T[] {
  const next = [...current, question];
  writeStored(key, startedAt, next, storage);
  return next;
}

/** Mark every currently logged attempt as reviewed while retaining the session boundary. */
export function completeSessionReview(
  key: string,
  startedAt: string,
  storage: Storage | undefined = browserStorage()
): void {
  writeStored(key, startedAt, [], storage);
}

/** Used by launch/resume screens to keep a completed quiz reachable until its review is taken. */
export function hasPendingSessionReview(
  key: string,
  startedAt: string,
  sessionQuestions: ReadonlyArray<{ userCorrect?: boolean }>,
  reviewedQuestionCount?: number,
  storage: Storage | undefined = browserStorage()
): boolean {
  const stored = readStored<{ userCorrect?: boolean }>(key, startedAt, storage);
  if (stored) return stored.length > 0;
  const answeredCount = sessionQuestions.filter((q) => q.userCorrect !== undefined).length;
  return reviewedQuestionCount !== undefined && answeredCount > reviewedQuestionCount;
}
