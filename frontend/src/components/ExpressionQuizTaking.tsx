import { useState } from "react";
import { useI18n } from "../i18n/context";
import { submitExpressionAnswer, gradeExpressionQuestion } from "../api/expressions";
import type { ExpressionQuizSubsession, ExpressionQuizQuestion, CorrectionItem } from "../types";

interface Props {
  language: string;
  expressionQuiz: ExpressionQuizSubsession;
  onComplete: () => void;
  onStartNew: () => void;
}

export default function ExpressionQuizTaking({ language, expressionQuiz: initial, onComplete, onStartNew }: Props) {
  const { t } = useI18n();
  const [quiz, setQuiz] = useState(initial);
  const [phase, setPhase] = useState<"question" | "loading" | "correction" | "complete">(
    initial.status === "completed" ? "complete" : "question"
  );
  const [userInput, setUserInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const currentQuestion: ExpressionQuizQuestion | undefined = quiz.questions.find(
    (q) => q.userCorrect === undefined && q.userInput === undefined
  );

  const answeredPendingGrade: ExpressionQuizQuestion | undefined = quiz.questions.find(
    (q) => q.userInput !== undefined && q.userCorrect === undefined
  );

  async function handleSubmitAnswer() {
    if (!currentQuestion || !userInput.trim()) return;
    setError(null);
    setPhase("loading");
    try {
      const result = await submitExpressionAnswer({
        language,
        expressionId: currentQuestion.expressionId,
        userInput: userInput.trim(),
      });
      setQuiz(result.expressionQuiz);
      setPhase("correction");
    } catch (err) {
      setError(String(err));
      setPhase("question");
    }
  }

  async function handleGrade(correct: boolean) {
    const question = answeredPendingGrade ?? currentQuestion;
    if (!question) return;
    try {
      const result = await gradeExpressionQuestion({
        language,
        expressionId: question.expressionId,
        correct,
      });
      setQuiz(result.expressionQuiz);
      setUserInput("");
      if (result.expressionQuiz.status === "completed") {
        setPhase("complete");
      } else {
        setPhase("question");
      }
    } catch (err) {
      setError(String(err));
    }
  }

  // ===== COMPLETE =====
  if (phase === "complete" || quiz.status === "completed") {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-6">
        <div className="rounded-xl bg-orange-900/20 border border-orange-700 p-6 text-center space-y-2">
          <p className="text-2xl font-bold text-orange-300">
            {quiz.score.correct} / {quiz.score.total}
          </p>
          <p className="text-gray-400">{t("quizComplete")}</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onStartNew}
            className="flex-1 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 transition-colors"
          >
            {t("startNew")}
          </button>
          <button
            onClick={onComplete}
            className="flex-1 rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t("backToHome")}
          </button>
        </div>
      </div>
    );
  }

  // ===== QUESTION =====
  if (phase === "question" && currentQuestion) {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {quiz.score.correct} / {quiz.score.total}
          </p>
          <button
            onClick={onComplete}
            className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-400 hover:bg-gray-700 transition-colors"
          >
            {t("back")}
          </button>
        </div>

        <div className="rounded-xl bg-orange-900/20 border border-orange-700 p-5 space-y-3">
          <p className="text-xs text-orange-400 font-semibold uppercase tracking-wider">
            {t("expressionPhrase")}
          </p>
          <p className="text-xl font-bold text-gray-100">{currentQuestion.phrase}</p>
          <div>
            <p className="text-xs text-gray-500 mb-0.5">{t("expressionContext")}</p>
            <p className="text-sm text-gray-300">{currentQuestion.context}</p>
          </div>
          {currentQuestion.description && (
            <div>
              <p className="text-xs text-gray-500 mb-0.5">{t("expressionDescription")}</p>
              <p className="text-sm text-gray-400 whitespace-pre-wrap">{currentQuestion.description}</p>
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-400">{t("useExpressionInSentence")}</label>
          <textarea
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            rows={4}
            className="w-full resize-y rounded-lg border border-gray-600 bg-gray-800 px-4 py-3 text-gray-100 placeholder-gray-500 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
          />
        </div>

        {error && (
          <div className="rounded bg-red-900/30 border border-red-700 p-3">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        <button
          onClick={handleSubmitAnswer}
          disabled={!userInput.trim()}
          className={`w-full rounded-lg px-5 py-3 font-medium text-white transition-colors ${
            userInput.trim()
              ? "bg-orange-600 hover:bg-orange-500"
              : "cursor-not-allowed bg-orange-600/40 text-white/50"
          }`}
        >
          {t("submitAnswer")}
        </button>
      </div>
    );
  }

  // ===== LOADING =====
  if (phase === "loading") {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-4">
        <div className="rounded-lg bg-gray-800/60 p-4 flex items-center gap-3">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-400 border-t-transparent" />
          <p className="text-sm text-orange-400">{t("correcting")}</p>
        </div>
      </div>
    );
  }

  // ===== CORRECTION =====
  const displayQuestion = answeredPendingGrade ?? currentQuestion;
  if (!displayQuestion?.correctionResult) return null;
  const { correctionResult } = displayQuestion;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-4">
      <p className="text-sm text-gray-500">{quiz.score.correct} / {quiz.score.total}</p>

      <div className="rounded-lg bg-orange-900/20 border border-orange-700 px-4 py-3">
        <p className="text-sm font-semibold text-orange-300">{displayQuestion.phrase}</p>
        <p className="text-xs text-gray-400 mt-0.5">{displayQuestion.context}</p>
      </div>

      <div className="rounded-lg bg-gray-800/60 p-4">
        <p className="text-xs text-gray-500 mb-1">{t("originalText")}</p>
        <p className="text-gray-100 whitespace-pre-wrap">{correctionResult.originalText}</p>
      </div>

      <div className="rounded-lg bg-teal-900/30 border border-teal-700 p-4">
        <p className="text-xs text-teal-400 font-semibold mb-1">{t("overallCorrectedText")}</p>
        <p className="text-gray-100 whitespace-pre-wrap">{correctionResult.correctedText}</p>
      </div>

      {correctionResult.corrections.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-400">{t("corrections")} ({correctionResult.corrections.length})</p>
          {correctionResult.corrections.map((c, i) => (
            <CorrectionCard key={i} correction={c} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg bg-green-900/30 border border-green-700 p-3">
          <p className="text-sm text-green-300">No corrections needed!</p>
        </div>
      )}

      <div className="rounded-lg bg-gray-800/60 p-4">
        <p className="text-sm text-teal-400 font-semibold mb-1">{t("overallFeedback")}</p>
        <p className="text-sm text-gray-300 whitespace-pre-wrap">{correctionResult.overallFeedback}</p>
      </div>

      {error && (
        <div className="rounded bg-red-900/30 border border-red-700 p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      <div className="rounded-lg border border-gray-700 p-4 space-y-2">
        <p className="text-sm text-gray-400 text-center">{t("grade")}</p>
        <div className="flex gap-3">
          <button
            onClick={() => handleGrade(true)}
            className="flex-1 rounded-lg bg-green-600 px-4 py-3 font-medium text-white hover:bg-green-500 transition-colors"
          >
            {t("iWasCorrect")}
          </button>
          <button
            onClick={() => handleGrade(false)}
            className="flex-1 rounded-lg bg-red-700 px-4 py-3 font-medium text-white hover:bg-red-600 transition-colors"
          >
            {t("iWasWrong")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CorrectionCard({ correction }: { correction: CorrectionItem }) {
  const { t } = useI18n();
  const severityConfig = {
    error: { label: t("severityError"), bg: "bg-red-900/40", border: "border-red-700", badge: "bg-red-700 text-red-100" },
    improvement: { label: t("severityImprovement"), bg: "bg-amber-900/30", border: "border-amber-700", badge: "bg-amber-700 text-amber-100" },
    style: { label: t("severityStyle"), bg: "bg-blue-900/30", border: "border-blue-700", badge: "bg-blue-700 text-blue-100" },
  };
  const config = severityConfig[correction.severity];
  return (
    <div className={`rounded-lg ${config.bg} border ${config.border} p-3 space-y-2`}>
      <span className={`rounded px-2 py-0.5 text-xs font-medium ${config.badge}`}>{config.label}</span>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="rounded-md bg-red-900/30 px-3 py-2">
          <p className="text-xs text-red-400 mb-0.5">Original</p>
          <p className="text-sm text-gray-200">{correction.original}</p>
        </div>
        <div className="rounded-md bg-green-900/30 px-3 py-2">
          <p className="text-xs text-green-400 mb-0.5">Corrected</p>
          <p className="text-sm text-gray-200">{correction.corrected}</p>
        </div>
      </div>
      <p className="text-sm text-gray-400">{correction.explanation}</p>
    </div>
  );
}
