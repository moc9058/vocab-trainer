import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ApiError, fetchJson } from "../api/client";
import { enqueueReviewOperation, getOutboxState, type ReviewOperation } from "../utils/answerOutbox";
import { sessionReviewQuestions, unreviewedSessionQuestions } from "../utils/sessionReview";
import { shuffle } from "../utils/mixedOperations";
import type { QuizReviewState } from "../types";

interface ReviewSession {
  sessionId: string;
  startedAt: string;
  language: string;
  questions: { userCorrect?: boolean }[];
  reviewedQuestionCount?: number;
  reviewState?: QuizReviewState;
}

/** Review cards advance locally; the serial outbox saves them after earlier answers.
 * Only the final response replaces the session, after all optimistic review moves have
 * landed, so a late response cannot rewind the cursor. Continuing the main test waits
 * for that final response (which releases retries and may reorder the mixed tail). */
export function useSessionReview<S extends ReviewSession>(
  session: S, setSession: Dispatch<SetStateAction<S>>, base: string,
) {
  const [opened, setOpened] = useState(session.reviewState?.status === "active");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"conflict" | "missing" | "load" | null>(null);
  const [unsynced, setUnsynced] = useState(0);
  const locked = useRef(false);
  const failed = useRef(false);
  const current = useRef(session);
  current.current = session;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const kind = base === "/api/quiz" ? "word" : base === "/api/grammar-quiz" ? "grammar"
      : base === "/api/expression-recall-quiz" ? "expression-recall" : "combined";
    try {
      localStorage.removeItem(`vocab-trainer:session-review:v2:${encodeURIComponent(kind)}:${encodeURIComponent(session.sessionId)}`);
    } catch { /* Storage can be disabled; the server is authoritative. */ }
  }, [base, session.sessionId]);
  const path = `${base}/session/language/${encodeURIComponent(session.language)}`;
  const state = session.reviewState;

  function move(action: "start" | "next") {
    if (locked.current || failed.current || getOutboxState().failed > 0) return;
    const saved = current.current;
    const state = saved.reviewState;
    if (action === "next" && state?.status !== "active") return;
    if (action === "start" && state?.status === "active") return;
    const answered = saved.questions.filter(q => q.userCorrect !== undefined).length;
    const from = saved.reviewedQuestionCount ?? answered;
    if (action === "start" && answered <= from) return;
    const operation: ReviewOperation = {
      action, startedAt: saved.startedAt,
      reviewId: action === "start" ? crypto.randomUUID() : state!.reviewId,
      operationId: crypto.randomUUID(), revision: action === "start" ? 0 : state!.revision,
      fromAnsweredCount: action === "start" ? from : state!.fromAnsweredCount,
      ...(action === "start" ? { questionOrder: shuffle(Array.from({ length: answered - from }, (_, i) => i)) } : {}),
    };
    const next: QuizReviewState = action === "start" ? {
      reviewId: operation.reviewId, status: "active", cursor: 0, revision: 0,
      fromAnsweredCount: from, toAnsweredCount: answered,
      lastOperationId: operation.operationId, questionOrder: operation.questionOrder,
    } : { ...state!, cursor: state!.cursor + 1, revision: state!.revision + 1,
      lastOperationId: operation.operationId };
    if (next.cursor >= next.toAnsweredCount - next.fromAnsweredCount) next.status = "completed";
    current.current = { ...saved, reviewState: next };
    // Preserve any membership removal queued by End Session in the same event.
    setSession(prev => ({ ...prev, reviewState: next }));
    setOpened(true);
    setError(null);
    setUnsynced(n => n + 1);
    void enqueueReviewOperation<S>(`${path}/review`, operation).then(result => {
      if (!mounted.current || failed.current) return;
      // Earlier confirmations carry an older cursor. Only the confirmed completion
      // may replace the session and release the next sitting's retries.
      if (next.status === "completed" && current.current.reviewState?.lastOperationId === operation.operationId) {
        current.current = result.session;
        setSession(result.session);
      }
    }).catch(err => {
      failed.current = true;
      if (mounted.current) setError(err instanceof ApiError && err.status === 404 ? "missing"
        : err instanceof ApiError && err.status === 409 ? "conflict" : "load");
    }).finally(() => {
      if (mounted.current) setUnsynced(n => n - 1);
    });
  }

  async function reload() {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    try {
      const saved = await fetchJson<S>(path);
      if (saved.startedAt !== session.startedAt) throw new ApiError(409, "The quiz session has been replaced");
      if (!mounted.current) return;
      current.current = saved;
      failed.current = false;
      setSession(saved);
      setOpened(!!saved.reviewState);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof ApiError && err.status === 404 ? "missing"
        : err instanceof ApiError && err.status === 409 ? "conflict" : "load");
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return {
    active: opened || state?.status === "active", index: state?.cursor ?? 0,
    questions: opened || state?.status === "active" ? sessionReviewQuestions<S["questions"][number]>(session)
      : unreviewedSessionQuestions<S["questions"][number]>(session.questions, session.reviewedQuestionCount), pending, error, syncing: unsynced > 0,
    start: () => { void move("start"); }, next: () => { if (state?.status === "active") void move("next"); },
    isBlocked: () => locked.current || failed.current,
    close: () => setOpened(false), reload: () => { void reload(); },
  };
}
