import { useState, useEffect } from "react";
import { getCurrentExpressionSession, startExpressionQuiz } from "../api/expressions";
import type { ExpressionQuizSubsession } from "../types";
import ExpressionQuizFilterModal from "./ExpressionQuizFilterModal";
import ExpressionQuizTaking from "./ExpressionQuizTaking";

interface Props {
  language: string;
  onBack: () => void;
}

type Phase = "loading" | "setup" | "quiz";

export default function ExpressionQuizView({ language, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [quiz, setQuiz] = useState<ExpressionQuizSubsession | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentExpressionSession(language).then((subsession) => {
      if (subsession && subsession.status === "in-progress") {
        setQuiz(subsession);
        setPhase("quiz");
      } else {
        setPhase("setup");
      }
    }).catch(() => setPhase("setup"));
  }, [language]);

  async function handleStart(filters: {
    purposeFilter: ("speaking" | "writing")[];
    groupIds: string[];
  }) {
    setStarting(true);
    setError(null);
    try {
      const subsession = await startExpressionQuiz({
        language,
        purposeFilter: filters.purposeFilter.length > 0 ? filters.purposeFilter : undefined,
        groupIds: filters.groupIds.length > 0 ? filters.groupIds : undefined,
      });
      setQuiz(subsession);
      setPhase("quiz");
    } catch (err) {
      setError(String(err));
    } finally {
      setStarting(false);
    }
  }

  if (phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-orange-400 border-t-transparent" />
      </div>
    );
  }

  if (phase === "setup") {
    return (
      <>
        {error && (
          <div className="mx-auto max-w-2xl p-4">
            <div className="rounded bg-red-900/30 border border-red-700 p-3">
              <p className="text-sm text-red-300">{error}</p>
            </div>
          </div>
        )}
        <ExpressionQuizFilterModal
          language={language}
          onStart={handleStart}
          onClose={onBack}
        />
      </>
    );
  }

  if (phase === "quiz" && quiz) {
    return (
      <ExpressionQuizTaking
        language={language}
        expressionQuiz={quiz}
        onComplete={onBack}
        onStartNew={() => setPhase("setup")}
      />
    );
  }

  return null;
}
