import { useState } from "react";
import { useI18n } from "../i18n/context";
import { answerQuestion } from "../api/quiz";
import type { QuizSession } from "../types";

interface Props {
  session: QuizSession;
  onComplete: () => void;
}

export default function QuizTaking({ session, onComplete }: Props) {
  const { t } = useI18n();
  const [currentSession, setCurrentSession] = useState(session);
  // Start from the first unanswered question (supports resume)
  const [currentIndex, setCurrentIndex] = useState(() => {
    const idx = session.questions.findIndex((q) => q.userCorrect === undefined);
    return idx === -1 ? session.questions.length : idx;
  });
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const questions = currentSession.questions;
  const isComplete = currentIndex >= questions.length;
  const question = isComplete ? null : questions[currentIndex];

  async function handleGrade(correct: boolean) {
    if (!question || submitting) return;
    setSubmitting(true);
    try {
      const { session: updated } = await answerQuestion({
        sessionId: currentSession.sessionId,
        wordId: question.wordId,
        correct,
      });
      setCurrentSession(updated);
      setCurrentIndex((i) => i + 1);
      setShowingAnswer(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (isComplete) {
    const { correct, total } = currentSession.score;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
        <h2 className="text-2xl font-bold text-gray-800">{t("quizComplete")}</h2>
        <p className="text-4xl font-semibold text-blue-600">
          {correct} / {total}
        </p>
        <button
          onClick={onComplete}
          className="rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700"
        >
          {t("backToHome")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <p className="text-sm text-gray-500">
        {currentIndex + 1} / {questions.length}
      </p>
      <h2 className="text-3xl font-bold text-gray-800">{question!.term}</h2>

      {!showingAnswer ? (
        <button
          onClick={() => setShowingAnswer(true)}
          className="rounded-lg bg-gray-200 px-6 py-2 text-gray-700 hover:bg-gray-300"
        >
          {t("showAnswer")}
        </button>
      ) : (
        <>
          <p className="text-2xl text-green-700">{question!.expectedAnswer}</p>

          {question!.transliteration && (
            <p className="text-lg text-gray-500">{question!.transliteration}</p>
          )}

          {question!.japaneseDefinition && (
            <p className="text-base text-gray-600">
              <span className="font-medium text-gray-500">{t("japaneseDefinition")}: </span>
              {question!.japaneseDefinition}
            </p>
          )}

          {question!.examples && question!.examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-50 p-4">
              <p className="mb-2 text-sm font-medium text-gray-500">{t("examples")}</p>
              {question!.examples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-base text-gray-800">{ex.sentence}</p>
                  <p className="text-sm text-gray-500">{ex.translation}</p>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-4">
            <button
              disabled={submitting}
              onClick={() => handleGrade(true)}
              className="rounded-lg bg-green-600 px-6 py-2 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {t("iWasCorrect")}
            </button>
            <button
              disabled={submitting}
              onClick={() => handleGrade(false)}
              className="rounded-lg bg-red-600 px-6 py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
