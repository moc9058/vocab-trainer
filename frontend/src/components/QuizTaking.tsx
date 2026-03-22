import { useState } from "react";
import { useI18n } from "../i18n/context";
import { answerQuestion } from "../api/quiz";
import RubyText from "./RubyText";
import type { QuizSession } from "../types";

interface Props {
  session: QuizSession;
  onComplete: () => void;
  onBrowse: () => void;
  onStartNew: () => void;
  transliterationMap?: Record<string, string>;
}

export default function QuizTaking({ session, onComplete, onBrowse, onStartNew, transliterationMap = {} }: Props) {
  const { t } = useI18n();
  const [currentSession, setCurrentSession] = useState(() => {
    // Shuffle unanswered questions so resume order is randomized
    const answered = session.questions.filter((q) => q.userCorrect !== undefined);
    const unanswered = session.questions.filter((q) => q.userCorrect === undefined);
    for (let i = unanswered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unanswered[i], unanswered[j]] = [unanswered[j], unanswered[i]];
    }
    return { ...session, questions: [...answered, ...unanswered] };
  });
  const [currentIndex, setCurrentIndex] = useState(() => {
    const idx = session.questions.findIndex((q) => q.userCorrect === undefined);
    return idx === -1 ? session.questions.length : idx;
  });
  const [originalTotal] = useState(() => session.wordIds?.length ?? session.questions.length);
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const questions = currentSession.questions;
  const isComplete = currentIndex >= questions.length;
  const question = isComplete ? null : questions[currentIndex];

  async function handleGrade(correct: boolean) {
    if (!question || submitting) return;
    setSubmitting(true);
    try {
      await answerQuestion({
        sessionId: currentSession.sessionId,
        wordId: question.wordId,
        correct,
      });
      // Merge result into existing shuffled state instead of replacing with backend order
      setCurrentSession((prev) => {
        const updatedQuestions = prev.questions.map((q) =>
          q === question ? { ...q, userCorrect: correct } : q
        );
        // If wrong, re-queue at the end for another attempt
        if (!correct) {
          updatedQuestions.push({
            wordId: question.wordId,
            term: question.term,
            definition: question.definition,
            transliteration: question.transliteration,
            examples: question.examples,
          });
        }
        const newScore = {
          correct: prev.score.correct + (correct ? 1 : 0),
          total: prev.score.total + (correct ? 0 : 1),
        };
        const allAnswered = updatedQuestions.every((q) => q.userCorrect !== undefined);
        return {
          ...prev,
          questions: updatedQuestions,
          score: newScore,
          status: allAnswered ? ("completed" as const) : prev.status,
          ...(allAnswered ? { completedAt: new Date().toISOString() } : {}),
        };
      });
      setCurrentIndex((i) => i + 1);
      setShowingAnswer(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (isComplete) {
    const { correct, total } = currentSession.score;
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
          onClick={() => setShowingAnswer(true)}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showAnswer")}
        </button>
      ) : (
        <>
          <div className="text-center space-y-1">
            {Object.entries(question!.definition ?? {}).map(([lang, text]) => (
              <p key={lang} className="text-xl text-green-400">
                <span className="text-sm text-gray-400">{lang}: </span>{text}
              </p>
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
                  <p className="text-lg text-gray-100"><RubyText text={ex.sentence} transliterationMap={transliterationMap} segments={ex.segments} /></p>
                  <p className="text-sm text-gray-400">{ex.translation}</p>
                </div>
              ))}
            </div>
          )}

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
