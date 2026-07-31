import { useState, useEffect, useRef, useCallback } from "react";
import { useI18n } from "../i18n/context";
import { getExpressionsByIds } from "../api/expressions";
import QuizLoadState from "./QuizLoadState";
import QuizSyncBadge from "./QuizSyncBadge";
import { useAnswerOutbox } from "../hooks/useAnswerOutbox";
import { applyExpressionRecallAnswerLocally } from "../utils/quizLocal";
import type { Expression, ExpressionRecallQuestion, ExpressionRecallSession } from "../types";

interface Props {
  /** ISO code — expressions are stored under ISO codes, unlike words and grammar. */
  language: string;
  session: ExpressionRecallSession;
  onComplete: () => void;
  onStartNew: () => void;
}

export default function ExpressionRecallTaking({
  language,
  session,
  onComplete,
  onStartNew,
}: Props) {
  const { t } = useI18n();
  const [currentSession, setCurrentSession] = useState(session);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const idx = session.questions.findIndex((q) => q.userCorrect === undefined);
    return idx === -1 ? session.questions.length : idx;
  });
  const [showingAnswer, setShowingAnswer] = useState(false);
  // Grading is synchronous; this only stops a double-tap grading the same card twice.
  const gradedIndexRef = useRef(-1);
  const [originalTotal] = useState(
    session.questions.filter((q) => q.userCorrect === undefined).length || session.questions.length
  );
  const [sessionLog, setSessionLog] = useState<ExpressionRecallQuestion[]>([]);
  const [sessionReviewActive, setSessionReviewActive] = useState(false);
  const [sessionReviewIndex, setSessionReviewIndex] = useState(0);

  const outbox = useAnswerOutbox();

  // Hydration. Deliberately NOT `useQuizPrefetch`: that hook is hardwired to the
  // word+grammar pair and chunks its requests because a word payload carries
  // definitions, examples and hanja readings. An Expression is four short
  // strings, so one batch call covers the whole session.
  //
  // Two properties are kept from the hook because both are load-bearing:
  //   - the id list is frozen at mount (retries reuse ids, so the SET never
  //     grows) — a re-queue therefore costs no network;
  //   - ids the server omits count as RESOLVED, not pending, or a card for an
  //     expression deleted mid-session would block forever.
  const [neededIds] = useState(() => [
    ...new Set(session.questions.map((q) => q.expressionId)),
  ]);
  const [payloads, setPayloads] = useState<Map<string, Expression>>(new Map());
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    getExpressionsByIds(language, neededIds)
      .then(({ items }) => {
        if (cancelled) return;
        setPayloads(new Map(items.map((e) => [e.id, e])));
        const found = new Set(items.map((e) => e.id));
        setMissing(new Set(neededIds.filter((id) => !found.has(id))));
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [language, neededIds, attempt]);

  const retryLoad = useCallback(() => setAttempt((n) => n + 1), []);

  // QuizSyncBadge's prop is structural, so a hand-rolled equivalent works without
  // pulling in the prefetch hook.
  const prefetchStatus = {
    loading,
    loaded: payloads.size + missing.size,
    total: neededIds.length,
    error: loadError,
    retry: retryLoad,
  };

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [currentIndex, sessionReviewIndex]);

  const orderedQuestions = currentSession.questions;
  const question = currentIndex < orderedQuestions.length ? orderedQuestions[currentIndex] : null;
  const isComplete = currentSession.status === "completed";
  const expression = question ? payloads.get(question.expressionId) : null;
  const reversed = currentSession.direction === "context-to-phrase";

  /** Local-first: apply the server's own mutation here and advance at once, then
   *  hand the write to the outbox. Awaiting the POST is what used to freeze the
   *  other quizzes on a weak connection. */
  function handleGrade(correct: boolean) {
    if (!question || gradedIndexRef.current === currentIndex) return;
    gradedIndexRef.current = currentIndex;
    outbox.enqueue({
      domain: "expressionRecall",
      language: currentSession.language,
      expressionId: question.expressionId,
      correct,
    });
    setCurrentSession((prev) =>
      applyExpressionRecallAnswerLocally(prev, question.expressionId, correct)
    );
    setSessionLog((prev) => [...prev, { ...question, userCorrect: correct }]);
    setCurrentIndex((i) => i + 1);
    setShowingAnswer(false);
  }

  function endSession() {
    if (sessionLog.length === 0) return;
    setSessionReviewIndex(0);
    setSessionReviewActive(true);
  }

  /** The reveal face: whichever side of the card wasn't the prompt. */
  function AnswerBody({ expr }: { expr: Expression | undefined }) {
    if (!expr) {
      return (
        <p className="max-w-lg text-center text-sm text-gray-500">{t("expressionDeleted")}</p>
      );
    }
    return (
      <div className="w-full max-w-lg space-y-3 rounded-lg bg-gray-700 p-4">
        <p className="text-lg text-gray-100">{reversed ? expr.phrase : expr.context}</p>
        {expr.description && <p className="text-sm text-gray-400">{expr.description}</p>}
        {expr.purpose && expr.purpose.length > 0 && (
          <div className="flex gap-1.5">
            {expr.purpose.map((p) => (
              <span
                key={p}
                className="rounded-full bg-gray-600 px-2 py-0.5 text-[11px] text-gray-300"
              >
                {p === "speaking" ? t("purposeSpeaking") : t("purposeWriting")}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (sessionReviewActive) {
    const reviewQuestion =
      sessionReviewIndex < sessionLog.length ? sessionLog[sessionReviewIndex] : null;

    if (!reviewQuestion) {
      const sessionCorrect = sessionLog.filter((q) => q.userCorrect).length;
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
          <h2 className="text-xl font-bold text-gray-100 sm:text-2xl">
            {t("sessionReviewComplete")}
          </h2>
          <p className="text-2xl font-semibold text-amber-400 sm:text-4xl">
            {sessionCorrect} / {sessionLog.length}
          </p>
          <button
            onClick={() => {
              onComplete();
              onStartNew();
            }}
            className="rounded-lg bg-amber-600 px-6 py-2 text-white hover:bg-amber-500"
          >
            {t("startNew")}
          </button>
        </div>
      );
    }

    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        <p className="text-sm text-gray-400">
          {sessionReviewIndex + 1} / {sessionLog.length}
        </p>
        <h2 className="max-w-lg text-center text-xl font-bold text-gray-100 sm:text-3xl">
          {reviewQuestion.prompt}
        </h2>
        <AnswerBody expr={payloads.get(reviewQuestion.expressionId)} />
        <div className="sticky bottom-0 z-10 flex w-full flex-col gap-3 bg-gray-900/95 py-2 sm:static sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:py-0">
          <button
            onClick={() => setSessionReviewIndex((i) => i + 1)}
            className="w-full rounded-lg bg-amber-600 px-6 py-3 text-white hover:bg-amber-500 sm:w-auto sm:py-2"
          >
            {t("next")}
          </button>
        </div>
      </div>
    );
  }

  if (isComplete || (!question && currentIndex >= orderedQuestions.length)) {
    const { correct } = currentSession.score;
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        {/* The likeliest moment to close the tab — surface anything still in flight. */}
        <QuizSyncBadge
          prefetch={prefetchStatus}
          pending={outbox.pending}
          failed={outbox.failed}
          onFlush={outbox.flush}
          onAcknowledgeFailed={outbox.acknowledgeFailed}
        />
        <h2 className="text-xl font-bold text-gray-100 sm:text-2xl">{t("quizComplete")}</h2>
        <p className="text-2xl font-semibold text-amber-400 sm:text-4xl">
          {correct} / {currentSession.score.total}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            onClick={onComplete}
            className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700"
          >
            {t("backToHome")}
          </button>
          <button
            onClick={onStartNew}
            className="rounded-lg bg-amber-600 px-6 py-2 text-white hover:bg-amber-500"
          >
            {t("startNew")}
          </button>
        </div>
      </div>
    );
  }

  // Gate on THIS card's payload, not merely on "loading finished" — otherwise a
  // card could reveal with a blank answer while both grade buttons stayed live,
  // recording an answer for an empty card. A `missing` id counts as resolved.
  const cardResolved =
    !!question &&
    (payloads.has(question.expressionId) || missing.has(question.expressionId));
  if (!cardResolved) {
    return (
      <QuizLoadState
        error={loadError}
        loaded={prefetchStatus.loaded}
        total={prefetchStatus.total}
        onRetry={retryLoad}
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <QuizSyncBadge
        prefetch={prefetchStatus}
        pending={outbox.pending}
        failed={outbox.failed}
        onFlush={outbox.flush}
        onAcknowledgeFailed={outbox.acknowledgeFailed}
      />
      <div className="sticky top-0 z-10 flex w-full items-center justify-center gap-3 bg-gray-900/95 py-2 sm:static sm:w-auto sm:bg-transparent sm:py-0">
        <p className="text-sm text-gray-400">
          {currentSession.score.correct} / {originalTotal}
        </p>
        <button
          onClick={endSession}
          title={t("endSession")}
          className="whitespace-nowrap rounded-full border border-amber-600/70 bg-amber-700/30 px-4 py-1.5 text-sm font-medium text-amber-200 hover:bg-amber-700/50"
        >
          🏁 {t("endSession")}
        </button>
      </div>

      <p className="text-xs uppercase tracking-wider text-gray-500">
        {reversed ? t("expressionContext") : t("expressionPhrase")}
      </p>
      <h2 className="max-w-lg text-center text-xl font-bold text-gray-100 sm:text-3xl">
        {question!.prompt}
      </h2>

      {!showingAnswer ? (
        <button
          onClick={() => setShowingAnswer(true)}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showAnswer")}
        </button>
      ) : (
        <>
          <AnswerBody expr={expression ?? undefined} />
          <div className="sticky bottom-0 z-10 flex w-full flex-col gap-3 bg-gray-900/95 py-2 sm:static sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:py-0">
            <button
              onClick={() => handleGrade(true)}
              className="w-full rounded-lg bg-green-600 px-6 py-3 text-white hover:bg-green-700 sm:w-auto sm:py-2"
            >
              {t("iWasCorrect")}
            </button>
            <button
              onClick={() => handleGrade(false)}
              className="w-full rounded-lg bg-red-600 px-6 py-3 text-white hover:bg-red-700 sm:w-auto sm:py-2"
            >
              {t("iWasWrong")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
