import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP } from "../settings/defaults";
import { answerQuestion, getQuizQuestions } from "../api/quiz";
import { getFlaggedWordIds } from "../api/flagged";
import { getGroups } from "../api/vocab";
import RubyText from "./RubyText";
import { displayTranslation, type QuizSession, type QuizQuestion } from "../types";

const BATCH_SIZE = 50;
const VISIBLE_ANSWER_ITEMS = 4;

interface Props {
  session: QuizSession;
  onComplete: () => void;
  onBrowse: () => void;
  onStartNew: () => void;
}

function TranslationDisplay({ translation }: { translation: string | Record<string, string> }) {
  const { displayExEntries } = useSettings();
  if (!translation) return null;
  if (typeof translation === "string") return <p className="text-sm text-gray-400">{translation}</p>;
  return (
    <>
      {displayExEntries(translation).map(([lang, text]) => (
        <p key={lang} className="text-sm text-gray-400">
          <span className="text-xs font-medium uppercase text-gray-500 mr-1">{lang}</span>{text}
        </p>
      ))}
    </>
  );
}

export default function QuizTaking({ session, onComplete, onBrowse, onStartNew }: Props) {
  const { t } = useI18n();
  const { settings, displayDefEntries } = useSettings();
  const [currentSession, setCurrentSession] = useState(session);
  const [questions, setQuestions] = useState<QuizQuestion[]>(session.questions);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [showAllDefinitions, setShowAllDefinitions] = useState(false);
  const [showAllExamples, setShowAllExamples] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [alreadyFlaggedIds, setAlreadyFlaggedIds] = useState<Set<string>>(new Set());
  const [originalTotal] = useState(() => session.wordIds?.length ?? session.questions.length);
  const [groupNameMap, setGroupNameMap] = useState<Map<string, string>>(new Map());

  // Track how many questions have been fetched from the server
  const fetchedCountRef = useRef(0);
  const fetchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const submittingRef = useRef(false);
  const totalQuestionsRef = useRef(session.questions.length);

  const fetchBatch = useCallback((offset: number, limit: number) => {
    const request = fetchQueueRef.current.then(async () => {
      const { questions: batch, total } = await getQuizQuestions(session.language, offset, limit);
      totalQuestionsRef.current = total;
      fetchedCountRef.current = Math.max(fetchedCountRef.current, offset + batch.length);
      setQuestions((prev) => {
        const newQuestions = [...prev];
        for (let i = 0; i < batch.length; i++) {
          const idx = offset + i;
          if (idx >= newQuestions.length) {
            newQuestions.push(batch[i]);
          } else {
            newQuestions[idx] = { ...newQuestions[idx], ...batch[i] };
          }
        }
        return newQuestions;
      });
    });
    fetchQueueRef.current = request.catch(() => {});
    return request;
  }, [session.language]);

  // Initial load: fetch first batch
  useEffect(() => {
    // Find the first unanswered question index to know where to start fetching
    const firstUnanswered = session.questions.findIndex((q) => q.userCorrect === undefined);
    const startOffset = Math.max(0, firstUnanswered === -1 ? 0 : firstUnanswered);
    setCurrentIndex(firstUnanswered === -1 ? session.questions.length : firstUnanswered);

    fetchBatch(startOffset, BATCH_SIZE).then(() => setLoading(false));
  }, [fetchBatch, session.questions]);

  // Prefetch next batch when halfway through current loaded questions
  useEffect(() => {
    if (loading) return;
    const loadedUnanswered = questions.filter((q) => q.userCorrect === undefined).length;
    const halfway = Math.floor(loadedUnanswered / 2);
    const answeredSinceLoad = questions.filter((q) => q.userCorrect !== undefined).length - (session.questions.filter((q) => q.userCorrect !== undefined).length);

    if (answeredSinceLoad >= halfway && fetchedCountRef.current < totalQuestionsRef.current) {
      fetchBatch(fetchedCountRef.current, BATCH_SIZE);
    }
  }, [currentIndex, loading, questions, fetchBatch, session.questions]);

  useEffect(() => {
    getFlaggedWordIds(session.language)
      .then(({ wordIds }) => setAlreadyFlaggedIds(new Set(wordIds)))
      .catch(() => setAlreadyFlaggedIds(new Set()));
  }, [session.language]);

  useEffect(() => {
    if (!session.groupMembership || Object.keys(session.groupMembership).length === 0) return;
    getGroups(session.language)
      .then((groups) => setGroupNameMap(new Map(groups.map((g) => [g.id, g.name]))))
      .catch(() => {});
  }, [session.language, session.groupMembership]);

  const question = currentIndex < questions.length ? questions[currentIndex] : null;
  const isComplete = currentSession.status === "completed";
  const definitions = question?.definitions ?? [];
  const examples = question?.examples ?? [];
  const visibleDefinitions = showAllDefinitions ? definitions : definitions.slice(0, VISIBLE_ANSWER_ITEMS);
  const visibleExamples = showAllExamples ? examples : examples.slice(0, VISIBLE_ANSWER_ITEMS);

  const groupProgress = useMemo(() => {
    const membership = currentSession.groupMembership;
    if (!membership || Object.keys(membership).length === 0) return null;
    const unansweredWordIds = new Set(
      questions.filter((q) => q.userCorrect === undefined).map((q) => q.wordId)
    );
    return Object.entries(membership).map(([gid, wordIds]) => ({
      id: gid,
      name: groupNameMap.get(gid) ?? gid,
      remaining: wordIds.filter((wid) => unansweredWordIds.has(wid)).length,
      total: wordIds.length,
    }));
  }, [currentSession.groupMembership, questions, groupNameMap]);

  function resetExpandedAnswers() {
    setShowAllDefinitions(false);
    setShowAllExamples(false);
  }

  function revealAnswer() {
    if (!question) return;
    resetExpandedAnswers();
    setShowingAnswer(true);
    setFlaggedIds(new Set([question.wordId]));
  }

  const segmentWords = useMemo(() => {
    if (!question?.examples) return [];
    const seen = new Set<string>();
    const result: { id: string; text: string; transliteration?: string }[] = [];
    for (const ex of question.examples) {
      for (const seg of ex.segments ?? []) {
        if (seg.id && seg.id !== question.wordId && !alreadyFlaggedIds.has(seg.id) && !seen.has(seg.id)) {
          seen.add(seg.id);
          result.push({ id: seg.id, text: seg.text, transliteration: seg.transliteration });
        }
      }
    }
    return result;
  }, [alreadyFlaggedIds, question]);

  function toggleFlag(id: string) {
    setFlaggedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleGrade(correct: boolean) {
    if (!question || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const submittedFlagIds = Array.from(flaggedIds);
    try {
      const { session: updatedSession } = await answerQuestion({
        sessionId: currentSession.sessionId,
        wordId: question.wordId,
        correct,
        flagWordIds: submittedFlagIds.length > 0 ? submittedFlagIds : undefined,
      });

      if (submittedFlagIds.length > 0) {
        setAlreadyFlaggedIds((prev) => new Set([...prev, ...submittedFlagIds]));
      }

      setQuestions((prev) => {
        const hydratedByWordId = new Map(prev.map((q) => [q.wordId, q]));
        return updatedSession.questions.map((q) => ({
          ...hydratedByWordId.get(q.wordId),
          ...q,
        }));
      });
      setCurrentSession(updatedSession);
      totalQuestionsRef.current = updatedSession.questions.length;
      if (!correct) {
        await fetchBatch(currentIndex + 1, BATCH_SIZE);
      }

      setCurrentIndex((i) => i + 1);
      setShowingAnswer(false);
      resetExpandedAnswers();
      setFlaggedIds(new Set());
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!showingAnswer) {
        if (question && !event.repeat && (event.key === " " || event.code === "Space")) {
          event.preventDefault();
          revealAnswer();
        }
        return;
      }

      if (submittingRef.current || event.repeat) return;
      if (event.key === "1") {
        event.preventDefault();
        void handleGrade(false);
      } else if (event.key === "2") {
        event.preventDefault();
        void handleGrade(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [question, showingAnswer, submitting, handleGrade]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-400">Loading questions...</p>
      </div>
    );
  }

  if (isComplete || (!question && currentIndex >= questions.length)) {
    const { correct } = currentSession.score;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("congratulations")}</h2>
        <p className="text-2xl sm:text-4xl font-semibold text-blue-400">
          {correct} / {originalTotal}
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => { onComplete(); onBrowse(); }}
            className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700"
          >
            {t("browseWords")}
          </button>
          <button
            onClick={() => { onComplete(); onStartNew(); }}
            className="rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-500"
          >
            {t("startNew")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <p className="text-sm text-gray-400">
        {currentSession.score.correct} / {originalTotal}
      </p>
      {groupProgress && (
        <div className="flex flex-wrap justify-center gap-2">
          {groupProgress.map((g) => (
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
        </div>
      )}
      <h2 className="text-xl sm:text-3xl font-bold text-gray-100">{question!.term}</h2>

      {!showingAnswer ? (
        <button
          onClick={revealAnswer}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showAnswer")}
        </button>
      ) : (
        <>
          {settings.showKoreanHanja && question!.hanjaReadings && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-px flex-1 bg-amber-500/50"></div>
                <span className="text-xs font-semibold text-amber-400">🀄 {t("sectionKoreanHanja")}</span>
                <div className="h-px flex-1 bg-amber-500/50"></div>
              </div>
              {question!.hanjaReadings.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-3">
                  {question!.hanjaReadings.map((r, i) => (
                  <div key={i} className="flex flex-col items-center rounded-lg bg-gray-800 px-3 py-2 text-center min-w-[56px]">
                    <div className="flex items-baseline gap-1 text-base font-medium text-gray-100">
                      <span>{r.simplifiedChar}</span>
                      {r.simplifiedChar !== r.traditionalChar && (
                        <>
                          <span className="text-xs text-gray-500">→</span>
                          <span className="text-amber-300">{r.traditionalChar}</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {r.hunEum.map((h, j) => (
                        <p key={j} className="text-xs text-gray-400">{h}</p>
                      ))}
                    </div>
                  </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-sm text-gray-400">{t("noKoreanHanja")}</p>
              )}
            </div>
          )}
          <div className="text-center space-y-2">
            {visibleDefinitions.map((m, mi) => (
              <div key={mi}>
                {m.partOfSpeech && <p className="text-xs text-gray-500 italic">{m.partOfSpeech}</p>}
                {(() => {
                  const py = m.pinyins && m.pinyins.length > 0
                    ? m.pinyins.join(" / ")
                    : (mi === 0 ? question!.transliteration : undefined);
                  return py ? <p className="text-sm text-gray-400">{py}</p> : null;
                })()}
                {displayDefEntries(m.text || {}).map(([lang, text]) => (
                  <p key={lang} className="text-xl text-green-400">
                    <span className="text-sm text-gray-400">{LANG_LABEL_MAP[lang] || lang}: </span>{text}
                  </p>
                ))}
              </div>
            ))}
            {definitions.length > VISIBLE_ANSWER_ITEMS && (
              <button
                type="button"
                onClick={() => setShowAllDefinitions((v) => !v)}
                className="mt-1 rounded-md border border-gray-600 bg-gray-700/60 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600 hover:text-gray-100"
              >
                {showAllDefinitions
                  ? `▲ ${t("showFewerDefinitions")}`
                  : `▼ ${t("showMoreDefinitions")} (${definitions.length - VISIBLE_ANSWER_ITEMS})`}
              </button>
            )}
          </div>

          {examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
              {visibleExamples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100"><RubyText text={ex.sentence} segments={ex.segments} /></p>
                  <TranslationDisplay translation={ex.translation} />
                </div>
              ))}
              {examples.length > VISIBLE_ANSWER_ITEMS && (
                <button
                  type="button"
                  onClick={() => setShowAllExamples((v) => !v)}
                  className="mt-2 w-full rounded-md border border-gray-600 bg-gray-600/30 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600/60 hover:text-gray-100"
                >
                  {showAllExamples
                    ? `▲ ${t("showFewerExamples")}`
                    : `▼ ${t("showMoreExamples")} (${examples.length - VISIBLE_ANSWER_ITEMS})`}
                </button>
              )}
            </div>
          )}

          <div className="w-full max-w-lg space-y-1">
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={flaggedIds.has(question!.wordId)}
                onChange={() => toggleFlag(question!.wordId)}
                className="accent-amber-500 w-4 h-4"
              />
              {t("flagForReview")}
            </label>
            {segmentWords.length > 0 && (
              <>
                <p className="text-xs text-gray-500 mt-2">{t("flagSegmentWords")}</p>
                {segmentWords.map((seg) => (
                  <label key={seg.id} className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none pl-4">
                    <input
                      type="checkbox"
                      checked={flaggedIds.has(seg.id)}
                      onChange={() => toggleFlag(seg.id)}
                      className="accent-amber-500 w-4 h-4"
                    />
                    <span className="text-gray-300">{seg.text}</span>
                    {seg.transliteration && (
                      <span className="text-gray-500">({seg.transliteration})</span>
                    )}
                  </label>
                ))}
              </>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
            <button
              disabled={submitting}
              onClick={() => handleGrade(false)}
              className="w-full sm:w-auto rounded-lg bg-red-600 px-6 py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
            <button
              disabled={submitting}
              onClick={() => handleGrade(true)}
              className="w-full sm:w-auto rounded-lg bg-green-600 px-6 py-2 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {t("iWasCorrect")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
