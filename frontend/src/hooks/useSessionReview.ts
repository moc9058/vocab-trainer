import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ApiError, fetchJson } from "../api/client";
import { enqueueReviewOperation, getOutboxState } from "../utils/answerOutbox";
import { sessionReviewQuestions, unreviewedSessionQuestions } from "../utils/sessionReview";
import type { QuizReviewState } from "../types";

interface ReviewSession {
  sessionId: string;
  startedAt: string;
  language: string;
  questions: { userCorrect?: boolean }[];
  reviewedQuestionCount?: number;
  reviewState?: QuizReviewState;
}

/** All review movement is confirmed by the server before showing the next card.
 * The same serial outbox flushes prior grades/removals first and retries a lost response
 * with the same operation ID. No session data is stored in localStorage. */
export function useSessionReview<S extends ReviewSession>(
  session: S, setSession: Dispatch<SetStateAction<S>>, base: string,
) {
  const [opened, setOpened] = useState(session.reviewState?.status === "active");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"conflict" | "missing" | "load" | null>(null);
  const locked = useRef(false);
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

  async function move(action: "start" | "next") {
    if (locked.current || getOutboxState().failed > 0) return;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await enqueueReviewOperation<S>(`${path}/review`, {
        action, startedAt: session.startedAt,
        reviewId: action === "start" ? crypto.randomUUID() : state!.reviewId,
        operationId: crypto.randomUUID(), revision: action === "start" ? 0 : state!.revision,
        fromAnsweredCount: action === "start"
          ? session.reviewedQuestionCount ?? session.questions.filter(q => q.userCorrect !== undefined).length
          : state!.fromAnsweredCount,
      });
      if (!mounted.current) return;
      setSession(result.session);
      setOpened(true);
    } catch (err) {
      if (mounted.current) setError(err instanceof ApiError && err.status === 404 ? "missing"
        : err instanceof ApiError && err.status === 409 ? "conflict" : "load");
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function reload() {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    try {
      const saved = await fetchJson<S>(path);
      if (saved.startedAt !== session.startedAt) throw new ApiError(409, "The quiz session has been replaced");
      if (!mounted.current) return;
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
      : unreviewedSessionQuestions<S["questions"][number]>(session.questions, session.reviewedQuestionCount), pending, error,
    start: () => { void move("start"); }, next: () => { if (state?.status === "active") void move("next"); },
    isBlocked: () => locked.current || error !== null,
    close: () => setOpened(false), reload: () => { void reload(); },
  };
}
