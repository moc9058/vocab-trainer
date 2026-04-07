import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP } from "../settings/defaults";
import { answerQuestion, getQuizQuestions } from "../api/quiz";
import RubyText from "./RubyText";
import { displayTranslation, type QuizSession, type QuizQuestion } from "../types";

const BATCH_SIZE = 50;

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
  const { displayDefEntries } = useSettings();
  const [currentSession, setCurrentSession] = useState(session);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [originalTotal] = useState(() => session.wordIds?.length ?? session.questions.length);

  // Track how many questions have been fetched from the server
  const fetchedCountRef = useRef(0);
  const fetchingRef = useRef(false);
  const totalQuestionsRef = useRef(session.questions.length);

  const fetchBatch = useCallback(async (offset: number, limit: number) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const { questions: batch, total } = await getQuizQuestions(session.language, offset, limit);
      totalQuestionsRef.current = total;
      fetchedCountRef.current = offset + batch.length;
      setQuestions((prev) => {
        // Append new questions, avoiding duplicates by offset
        const newQuestions = [...prev];
        for (let i = 0; i < batch.length; i++) {
          const idx = offset + i;
          if (idx >= newQuestions.length) {
            newQuestions.push(batch[i]);
          } else if (!newQuestions[idx].definitions || newQuestions[idx].definitions.length === 0) {
            // Hydrate if the slot exists but has no definitions
            newQuestions[idx] = { ...newQuestions[idx], ...batch[i] };
          }
        }
        return newQuestions;
      });
    } finally {
      fetchingRef.current = false;
    }
  }, [session.language]);

  // Initial load: fetch first batch
  useEffect(() => {
    // Find the first unanswered question index to know where to start fetching
    const firstUnanswered = session.questions.findIndex((q) => q.userCorrect === undefined);
    const startOffset = Math.max(0, firstUnanswered === -1 ? 0 : firstUnanswered);
    setCurrentIndex(firstUnanswered === -1 ? session.questions.length : 0);

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

  const question = currentIndex < questions.length ? questions[currentIndex] : null;
  const isComplete = currentSession.status === "completed";

  const segmentWords = useMemo(() => {
    if (!question?.examples) return [];
    const seen = new Set<string>();
    const result: { id: string; text: string; transliteration?: string }[] = [];
    for (const ex of question.examples) {
      for (const seg of ex.segments ?? []) {
        if (seg.id && seg.id !== question.wordId && !seen.has(seg.id)) {
          seen.add(seg.id);
          result.push({ id: seg.id, text: seg.text, transliteration: seg.transliteration });
        }
      }
    }
    return result;
  }, [question]);

  function toggleFlag(id: string) {
    setFlaggedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleGrade(correct: boolean) {
    if (!question || submitting) return;
    setSubmitting(true);
    try {
      await answerQuestion({
        sessionId: currentSession.sessionId,
        wordId: question.wordId,
        correct,
        flagWordIds: flaggedIds.size > 0 ? Array.from(flaggedIds) : undefined,
      });

      setQuestions((prev) => {
        const updated = prev.map((q, i) =>
          i === currentIndex ? { ...q, userCorrect: correct } : q
        );
        // If wrong, re-queue at the end for another attempt
        if (!correct) {
          updated.push({
            wordId: question.wordId,
            term: question.term,
            definitions: question.definitions,
            transliteration: question.transliteration,
            examples: question.examples,
          });
        }
        return updated;
      });

      setCurrentSession((prev) => {
        const newScore = {
          correct: prev.score.correct + (correct ? 1 : 0),
          total: prev.score.total + (correct ? 0 : 1),
        };
        // Check completion: all loaded questions answered and no more to fetch
        const remainingUnanswered = questions.filter((q, i) => i !== currentIndex && q.userCorrect === undefined).length;
        const noMoreToFetch = fetchedCountRef.current >= totalQuestionsRef.current;
        const allDone = remainingUnanswered === 0 && noMoreToFetch && correct;

        return {
          ...prev,
          score: newScore,
          ...(allDone ? { status: "completed" as const, completedAt: new Date().toISOString() } : {}),
        };
      });

      setCurrentIndex((i) => i + 1);
      setShowingAnswer(false);
      setFlaggedIds(new Set());
    } finally {
      setSubmitting(false);
    }
  }

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
      <h2 className="text-xl sm:text-3xl font-bold text-gray-100">{question!.term}</h2>

      {!showingAnswer ? (
        <button
          onClick={() => { setShowingAnswer(true); setFlaggedIds(new Set([question!.wordId])); }}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showAnswer")}
        </button>
      ) : (
        <>
          <div className="text-center space-y-2">
            {(question!.definitions ?? []).map((m, mi) => (
              <div key={mi}>
                {m.partOfSpeech && <p className="text-xs text-gray-500 italic">{m.partOfSpeech}</p>}
                {displayDefEntries(m.text || {}).map(([lang, text]) => (
                  <p key={lang} className="text-xl text-green-400">
                    <span className="text-sm text-gray-400">{LANG_LABEL_MAP[lang] || lang}: </span>{text}
                  </p>
                ))}
              </div>
            ))}
          </div>

          {question!.transliteration && (
            <p className="text-xl text-gray-400">{question!.transliteration}</p>
          )}

          {question!.examples && question!.examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
              {question!.examples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100"><RubyText text={ex.sentence} segments={ex.segments} /></p>
                  <TranslationDisplay translation={ex.translation} />
                </div>
              ))}
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
              onClick={() => handleGrade(true)}
              className="w-full sm:w-auto rounded-lg bg-green-600 px-6 py-2 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {t("iWasCorrect")}
            </button>
            <button
              disabled={submitting}
              onClick={() => handleGrade(false)}
              className="w-full sm:w-auto rounded-lg bg-red-600 px-6 py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
