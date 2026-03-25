import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { answerGrammarQuestion } from "../api/grammar";
import { fetchJson } from "../api/client";
import type { GrammarQuizSession, GrammarItemDoc } from "../types";

interface Props {
  session: GrammarQuizSession;
  onComplete: () => void;
  onStartNew: () => void;
}

export default function GrammarQuizTaking({ session, onComplete, onStartNew }: Props) {
  const { t } = useI18n();
  const [currentSession, setCurrentSession] = useState(session);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const idx = session.questions.findIndex((q) => q.userCorrect === undefined);
    return idx === -1 ? session.questions.length : idx;
  });
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [componentCache, setComponentCache] = useState<Map<string, GrammarItemDoc>>(new Map());
  const [originalTotal] = useState(session.questions.filter((q) => q.userCorrect === undefined).length || session.questions.length);

  // Fetch grammar item details for showing title/description on answer reveal
  useEffect(() => {
    const ids = [...new Set(session.questions.map((q) => q.componentId))];
    for (const id of ids) {
      if (!componentCache.has(id)) {
        fetchJson<GrammarItemDoc>(`/api/grammar/${encodeURIComponent(session.language)}/items/${encodeURIComponent(id)}`)
          .then((item) => {
            setComponentCache((prev) => new Map(prev).set(id, item));
          })
          .catch(() => {});
      }
    }
  }, [session.questions, session.language]);

  const question = currentIndex < currentSession.questions.length
    ? currentSession.questions[currentIndex]
    : null;
  const isComplete = currentSession.status === "completed";
  const component = question ? componentCache.get(question.componentId) : null;

  async function handleGrade(correct: boolean) {
    if (!question || submitting) return;
    setSubmitting(true);
    try {
      const result = await answerGrammarQuestion({
        language: currentSession.language,
        componentId: question.componentId,
        correct,
      });
      setCurrentSession(result.session);
      setCurrentIndex((i) => i + 1);
      setShowingAnswer(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (isComplete || (!question && currentIndex >= currentSession.questions.length)) {
    const { correct } = currentSession.score;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("congratulations")}</h2>
        <p className="text-2xl sm:text-4xl font-semibold text-emerald-400">
          {correct} / {originalTotal}
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => { onComplete(); onStartNew(); }}
            className="rounded-lg bg-emerald-600 px-6 py-2 text-white hover:bg-emerald-500"
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

      {/* Display sentence (in user's display language) */}
      <div className="w-full max-w-lg rounded-lg bg-gray-800 border border-gray-700 p-6 text-center">
        <p className="text-xl text-gray-100">{question!.displaySentence}</p>
        {currentSession.language === "chinese" && component && (
          <p className="text-sm text-blue-300 mt-2">
            {component.term.ja || Object.values(component.term)[0]}
          </p>
        )}
      </div>

      {!showingAnswer ? (
        <button
          onClick={() => setShowingAnswer(true)}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showGrammarAnswer")}
        </button>
      ) : (
        <>
          {/* Chinese sentence */}
          <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4 text-center">
            <p className="text-2xl text-green-400">{question!.chineseSentence}</p>
          </div>

          {/* Grammar component details */}
          {component && (
            <div className="w-full max-w-lg rounded-lg bg-gray-800 border border-gray-600 p-4">
              <p className="text-sm font-medium text-blue-400 mb-1">
                {component.term.en || component.term.ja}
              </p>
              {component.description && Object.entries(component.description).map(([lang, text]) => (
                text && <p key={lang} className="text-sm text-gray-300">
                  <span className="text-xs text-gray-500">[{lang}] </span>{text}
                </p>
              ))}
            </div>
          )}

          {/* Self-grade buttons */}
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
