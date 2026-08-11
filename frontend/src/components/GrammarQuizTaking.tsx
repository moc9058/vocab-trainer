import { useState, useEffect, useMemo, useRef } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { getGrammarGroups, updateGrammarQuizWeights } from "../api/grammar";
import RubyText from "./RubyText";
import GrammarDescriptionsPanel from "./GrammarDescriptionsPanel";
import QuizLoadState from "./QuizLoadState";
import QuizSyncBadge from "./QuizSyncBadge";
import { useQuizPrefetch } from "../hooks/useQuizPrefetch";
import { useAnswerOutbox } from "../hooks/useAnswerOutbox";
import { applyGrammarAnswerLocally } from "../utils/quizLocal";
import {
  appendSessionReview,
  completeSessionReview,
  loadSessionReview,
  sessionReviewKey,
  unreviewedSessionQuestions,
} from "../utils/sessionReview";
import type { GrammarQuizSession, GrammarQuizQuestion } from "../types";
import { isWeightValid, scaleWeightRecord } from "../utils/weightInput";

/** Stable empty array — the grammar quiz has no word questions to prefetch. */
const EMPTY_IDS: string[] = [];

interface Props {
  session: GrammarQuizSession;
  onComplete: () => void;
  onStartNew: () => void;
}

export default function GrammarQuizTaking({ session, onComplete, onStartNew }: Props) {
  const { t } = useI18n();
  const { displayGrammarDefEntries } = useSettings();
  const [currentSession, setCurrentSession] = useState(session);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const idx = session.questions.findIndex((q) => q.userCorrect === undefined);
    return idx === -1 ? session.questions.length : idx;
  });
  const [showingAnswer, setShowingAnswer] = useState(false);
  // Grading is synchronous now; this only stops a double-tap grading the same card twice.
  const gradedIndexRef = useRef(-1);
  const [originalTotal] = useState(
    session.questions.filter((q) => q.userCorrect === undefined).length || session.questions.length
  );
  const [groupNameMap, setGroupNameMap] = useState<Map<string, string>>(new Map());
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [weightDraft, setWeightDraft] = useState<Record<string, string>>({});
  const [correctDraft, setCorrectDraft] = useState<string>("");
  const [applyingWeights, setApplyingWeights] = useState(false);
  // Durable End Session boundary; see `utils/sessionReview.ts`.
  const reviewKey = sessionReviewKey("grammar", session.sessionId);
  const [sessionLog, setSessionLog] = useState<GrammarQuizQuestion[]>(() =>
    loadSessionReview(
      reviewKey,
      session.startedAt,
      unreviewedSessionQuestions(session.questions, session.reviewedQuestionCount)
    )
  );
  const [sessionReviewActive, setSessionReviewActive] = useState(false);
  const [sessionReviewIndex, setSessionReviewIndex] = useState(0);

  const outbox = useAnswerOutbox();

  // Grammar items (descriptions + examples) for the answer reveal, loaded up front in batches.
  // This used to be one HTTP request per item fired in an unbounded fan-out on mount, with no
  // in-flight guard and no loading gate — so a card could reveal with nothing on it.
  // Computed once and frozen — see the note in `QuizTaking.tsx`.
  const orderedQuestions = currentSession.questions;
  const [prefetchGrammarIds] = useState(() =>
    session.questions.map((q) => q.grammarId)
  );
  const prefetch = useQuizPrefetch(currentSession.language, EMPTY_IDS, prefetchGrammarIds);

  useEffect(() => {
    if (!session.groupMembership || Object.keys(session.groupMembership).length === 0) return;
    getGrammarGroups(session.language)
      .then((groups) => setGroupNameMap(new Map(groups.map((g) => [g.id, g.name]))))
      .catch(() => {});
  }, [session.language, session.groupMembership]);

  // Mobile: the page scrolls when an answer is tall (min-h-full container), so
  // reset to the top on each new question — otherwise the term stays off-screen.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [currentIndex, sessionReviewIndex]);

  const question =
    currentIndex < orderedQuestions.length ? orderedQuestions[currentIndex] : null;
  const isComplete = currentSession.status === "completed";
  const grammar = question ? prefetch.grammar.get(question.grammarId) : null;

  const groupProgress = useMemo(() => {
    const membership = currentSession.groupMembership;
    if (!membership || Object.keys(membership).length === 0) return null;
    const unansweredIds = new Set(
      currentSession.questions.filter((q) => q.userCorrect === undefined).map((q) => q.grammarId)
    );
    return Object.entries(membership).map(([gid, ids]) => ({
      id: gid,
      name: groupNameMap.get(gid) ?? gid,
      remaining: ids.filter((id) => unansweredIds.has(id)).length,
      total: ids.length,
    }));
  }, [currentSession.groupMembership, currentSession.questions, groupNameMap]);

  function openWeightsPanel() {
    const membership = currentSession.groupMembership ?? {};
    setWeightDraft(
      Object.fromEntries(
        Object.keys(membership).map((gid) => [gid, String(currentSession.groupWeights?.[gid] ?? 1)])
      )
    );
    setCorrectDraft(currentSession.correctWeight !== undefined ? String(currentSession.correctWeight) : "");
    setWeightsOpen(true);
  }

  const correctDraftInvalid = correctDraft.trim() !== "" && !isWeightValid(correctDraft, 0);
  const hasInvalidWeightDraft =
    Object.keys(weightDraft).some((gid) => !isWeightValid(weightDraft[gid], 0)) || correctDraftInvalid;

  // Apply new group weights mid-session: the server reorders the unanswered tail and
  // returns the full session; jump to the first unanswered question of the new order.
  async function applyWeights() {
    if (applyingWeights || hasInvalidWeightDraft) return;
    setApplyingWeights(true);
    try {
      // Scale groups + already-correct together so decimal weights become integers (10, 0.3 -> 100, 3).
      const correctActive = correctDraft.trim() !== "";
      const raws: Record<string, string> = { ...weightDraft };
      if (correctActive) raws.__correct__ = correctDraft;
      const scaled = scaleWeightRecord(raws);
      const weights = Object.fromEntries(Object.keys(weightDraft).map((gid) => [gid, scaled[gid] ?? 0]));
      const correctWeight = correctActive ? scaled.__correct__ : undefined;
      const updated = await updateGrammarQuizWeights(currentSession.language, weights, correctWeight);
      setCurrentSession(updated);
      const firstUnanswered = updated.questions.findIndex((q) => q.userCorrect === undefined);
      // The new order can land the cursor back on an index already graded this session; the
      // double-tap guard keys off the index, so it must be cleared or that card is unanswerable.
      gradedIndexRef.current = -1;
      setCurrentIndex(firstUnanswered === -1 ? updated.questions.length : firstUnanswered);
      setShowingAnswer(false);
      setWeightsOpen(false);
    } catch {
      // Keep the panel open so the user can retry.
    } finally {
      setApplyingWeights(false);
    }
  }

  /** Local-first — see `utils/quizLocal.ts`. The write is queued, never awaited. */
  function handleGrade(correct: boolean) {
    if (!question || gradedIndexRef.current === currentIndex) return;
    gradedIndexRef.current = currentIndex;

    outbox.enqueue({
      domain: "grammar",
      language: currentSession.language,
      grammarId: question.grammarId,
      correct,
    });

    setCurrentSession((prev) => applyGrammarAnswerLocally(prev, question.grammarId, correct));
    const reviewQuestion = { ...question, userCorrect: correct };
    setSessionLog((prev) =>
      appendSessionReview(reviewKey, session.startedAt, prev, reviewQuestion)
    );
    setCurrentIndex((i) => i + 1);
    setShowingAnswer(false);
  }

  function endSession() {
    if (sessionLog.length === 0) return;
    setSessionReviewIndex(0);
    setSessionReviewActive(true);
  }

  function nextSessionReview() {
    const next = sessionReviewIndex + 1;
    if (next >= sessionLog.length) {
      completeSessionReview(reviewKey, session.startedAt);
      outbox.enqueue({
        domain: "grammarReviewComplete",
        language: currentSession.language,
        startedAt: session.startedAt,
      });
    }
    setSessionReviewIndex(next);
  }

  if (sessionReviewActive) {
    const reviewQuestion = sessionReviewIndex < sessionLog.length ? sessionLog[sessionReviewIndex] : null;

    if (!reviewQuestion) {
      const sessionCorrect = sessionLog.filter((q) => q.userCorrect).length;
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("sessionReviewComplete")}</h2>
          <p className="text-2xl sm:text-4xl font-semibold text-emerald-400">
            {sessionCorrect} / {sessionLog.length}
          </p>
          <button
            onClick={() => { onComplete(); onStartNew(); }}
            className="rounded-lg bg-emerald-600 px-6 py-2 text-white hover:bg-emerald-500"
          >
            {t("startNew")}
          </button>
        </div>
      );
    }

    const reviewGrammar = prefetch.grammar.get(reviewQuestion.grammarId);
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        <p className="text-sm text-gray-400">
          {sessionReviewIndex + 1} / {sessionLog.length}
        </p>
        <h2 className="max-w-lg text-center text-xl sm:text-3xl font-bold text-gray-100">
          {reviewQuestion.statement || reviewGrammar?.statement}
        </h2>

        {reviewGrammar && <GrammarDescriptionsPanel item={reviewGrammar} />}

        {reviewGrammar && reviewGrammar.examples && reviewGrammar.examples.length > 0 && (
          <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
            <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
            {reviewGrammar.examples.map((ex, i) => (
              <div key={i} className="mb-2 last:mb-0">
                <p className="text-lg text-gray-100">
                  <RubyText text={ex.sentence} segments={ex.segments} />
                </p>
                {ex.transliteration && <p className="text-sm text-gray-500">{ex.transliteration}</p>}
                {typeof ex.translation === "string" ? (
                  ex.translation && <p className="text-sm text-gray-400">{ex.translation}</p>
                ) : (
                  displayGrammarDefEntries(ex.translation).map(([lang, text]) => (
                    <p key={lang} className="text-sm text-gray-400">
                      <span className="mr-1 text-xs font-medium uppercase text-gray-500">{lang}</span>
                      {text}
                    </p>
                  ))
                )}
              </div>
            ))}
          </div>
        )}

        <div className="sticky bottom-0 z-10 flex w-full flex-col gap-3 bg-gray-900/95 py-2 sm:static sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:py-0">
          <button
            onClick={nextSessionReview}
            className="w-full sm:w-auto rounded-lg bg-emerald-600 px-6 py-3 sm:py-2 text-white hover:bg-emerald-500"
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
        {/* The likeliest moment to close the tab — surface any answers still in flight. */}
        <QuizSyncBadge
          prefetch={prefetch}
          pending={outbox.pending}
          failed={outbox.failed}
          onFlush={outbox.flush}
          onAcknowledgeFailed={outbox.acknowledgeFailed}
        />
        <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("congratulations")}</h2>
        <p className="text-2xl sm:text-4xl font-semibold text-emerald-400">
          {correct} / {originalTotal}
        </p>
        {sessionLog.length > 0 ? (
          <button
            onClick={endSession}
            className="rounded-lg border border-amber-600/70 bg-amber-700/30 px-6 py-2 font-medium text-amber-200 hover:bg-amber-700/50"
          >
            🏁 {t("endSession")}
          </button>
        ) : (
          <button
            onClick={() => {
              onComplete();
              onStartNew();
            }}
            className="rounded-lg bg-emerald-600 px-6 py-2 text-white hover:bg-emerald-500"
          >
            {t("startNew")}
          </button>
        )}
      </div>
    );
  }

  // Gate on THIS card's item — see the note in `QuizTaking.tsx`. Without it the reveal renders
  // no descriptions at all (the panel is conditional on `grammar`) while grading stays live.
  const cardResolved =
    !!question &&
    (prefetch.grammar.has(question.grammarId) || prefetch.missing.has(question.grammarId));
  if (!cardResolved) {
    return (
      <QuizLoadState
        error={prefetch.error}
        loaded={prefetch.loaded}
        total={prefetch.total}
        onRetry={prefetch.retry}
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <QuizSyncBadge
        prefetch={prefetch}
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
          className="rounded-full border border-amber-600/70 bg-amber-700/30 px-4 py-1.5 text-sm font-medium text-amber-200 hover:bg-amber-700/50 whitespace-nowrap"
        >
          🏁 {t("endSession")}
        </button>
      </div>

      <div className="flex flex-wrap justify-center gap-2 items-center">
        {groupProgress && groupsOpen &&
          groupProgress.map((g) => (
            <span
              key={g.id}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                g.remaining === 0
                  ? "bg-green-900/40 text-green-400 border border-green-700/50"
                  : "bg-gray-700 text-gray-300 border border-gray-600"
              }`}
            >
              {g.name}: {g.remaining}/{g.total}
            </span>
          ))}
        {groupProgress && (
          <button
            onClick={() => setGroupsOpen((v) => !v)}
            aria-pressed={groupsOpen}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              groupsOpen
                ? "border-gray-400 bg-gray-700 text-gray-100"
                : "border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            🏷 {t("grammarGroups")}
          </button>
        )}
        <button
          onClick={() => (weightsOpen ? setWeightsOpen(false) : openWeightsPanel())}
          className="rounded-full border border-gray-600 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
        >
          ⚖ {t("adjustWeights")}
        </button>
      </div>

      {/* Mid-session group weight editor */}
      {weightsOpen && (
        <div className="w-full max-w-lg rounded-lg border border-gray-600 bg-gray-800 p-4 space-y-2">
          <p className="text-sm font-medium text-gray-300">{t("adjustWeights")}</p>
          {Object.keys(currentSession.groupMembership ?? {}).length > 0 && (
            <details open>
              <summary className="cursor-pointer text-xs font-semibold text-emerald-300 select-none">
                {t("grammarGroups")} ({Object.keys(currentSession.groupMembership ?? {}).length})
              </summary>
              <div className="mt-1 space-y-1">
                {Object.keys(currentSession.groupMembership ?? {}).map((gid) => {
                  const invalid = !isWeightValid(weightDraft[gid], 0);
                  return (
                    <label key={gid} className="flex items-center gap-2 text-sm text-gray-300">
                      <span className="flex-1 min-w-0 truncate pl-4">{groupNameMap.get(gid) ?? gid}</span>
                      <input
                        type="number"
                        min={0}
                        value={weightDraft[gid] ?? "1"}
                        title={t("groupWeightHint")}
                        aria-label={t("groupWeight")}
                        onChange={(e) => {
                          setWeightDraft((prev) => ({ ...prev, [gid]: e.target.value }));
                        }}
                        className={`w-16 shrink-0 rounded border bg-gray-700 px-2 py-1 text-xs text-gray-100 focus:outline-none ${
                          invalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-emerald-400"
                        }`}
                      />
                    </label>
                  );
                })}
              </div>
            </details>
          )}
          {/* Already-correct bucket: peer to the groups (blank = off, 0 = exclude mastered). */}
          <label className="flex items-center gap-2 text-sm text-gray-300" title={t("alreadyCorrectHint")}>
            <span className="flex-1 min-w-0 truncate">✅ {t("alreadyCorrect")}</span>
            <input
              type="number"
              min={0}
              placeholder="—"
              value={correctDraft}
              aria-label={t("alreadyCorrect")}
              onChange={(e) => setCorrectDraft(e.target.value)}
              className={`w-16 shrink-0 rounded border bg-gray-700 px-2 py-1 text-xs text-gray-100 focus:outline-none ${
                correctDraftInvalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-emerald-400"
              }`}
            />
          </label>
          {hasInvalidWeightDraft && (
            <p className="text-xs text-red-400">{t("groupWeightRequiredHint")}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setWeightsOpen(false)}
              className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700"
            >
              {t("cancel")}
            </button>
            <button
              onClick={applyWeights}
              disabled={applyingWeights || hasInvalidWeightDraft}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {applyingWeights ? "..." : t("applyWeights")}
            </button>
          </div>
        </div>
      )}

      {/* Question: the grammar element itself (user must recall its meaning/usage) */}
      <h2 className="max-w-lg text-center text-xl sm:text-3xl font-bold text-gray-100">
        {question!.statement || grammar?.statement}
      </h2>

      {!showingAnswer ? (
        <button
          onClick={() => setShowingAnswer(true)}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showGrammarAnswer")}
        </button>
      ) : (
        <>
          {/* Reveal: descriptions (statement pinyin + per-description pinyins included) */}
          {grammar && <GrammarDescriptionsPanel item={grammar} />}

          {/* Registered examples (if any) */}
          {grammar && grammar.examples && grammar.examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
              {grammar.examples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100">
                    <RubyText text={ex.sentence} segments={ex.segments} />
                  </p>
                  {ex.transliteration && (
                    <p className="text-sm text-gray-500">{ex.transliteration}</p>
                  )}
                  {typeof ex.translation === "string" ? (
                    ex.translation && <p className="text-sm text-gray-400">{ex.translation}</p>
                  ) : (
                    displayGrammarDefEntries(ex.translation).map(([lang, text]) => (
                      <p key={lang} className="text-sm text-gray-400">
                        <span className="mr-1 text-xs font-medium uppercase text-gray-500">{lang}</span>
                        {text}
                      </p>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Self-grade buttons */}
          <div className="sticky bottom-0 z-10 flex w-full flex-col gap-3 bg-gray-900/95 py-2 sm:static sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:py-0">
            <button
              onClick={() => handleGrade(true)}
              className="w-full sm:w-auto rounded-lg bg-green-600 px-6 py-3 sm:py-2 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {t("iWasCorrect")}
            </button>
            <button
              onClick={() => handleGrade(false)}
              className="w-full sm:w-auto rounded-lg bg-red-600 px-6 py-3 sm:py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
