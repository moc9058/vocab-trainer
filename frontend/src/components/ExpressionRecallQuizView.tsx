import { useState, useEffect, useCallback } from "react";
import {
  getCurrentExpressionRecallSession,
  startExpressionRecallQuiz,
} from "../api/expression-recall-quiz";
import type { ExpressionQuizDirection, ExpressionRecallSession } from "../types";
import ExpressionRecallFilterModal from "./ExpressionRecallFilterModal";
import ExpressionRecallTaking from "./ExpressionRecallTaking";
import QuizRecoveryState from "./QuizRecoveryState";

interface Props {
  /** ISO code — expressions are stored under ISO codes, unlike words and grammar. */
  language: string;
  onBack: () => void;
}

type Phase = "loading" | "setup" | "quiz" | "unreachable";

export default function ExpressionRecallQuizView({ language, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [quiz, setQuiz] = useState<ExpressionRecallSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // This component owns the resume, which is what makes the real URL worth
  // having: a refresh on /:language/expression-recall lands back in the session
  // instead of dropping to the setup screen.
  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    getCurrentExpressionRecallSession(language)
      .then((session) => {
        if (cancelled) return;
        if (session && session.status === "in-progress") {
          setQuiz(session);
          setPhase("quiz");
        } else {
          setPhase("setup");
        }
      })
      .catch(() => {
        // 404 already came back as null, so anything reaching here is a transport
        // failure. Showing the setup screen would look like "you have no quiz",
        // which is the bug the other quizzes fixed with QuizRecoveryState.
        if (!cancelled) setPhase("unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, [language, attempt]);

  const handleStart = useCallback(
    async (filters: {
      purposeFilter: ("speaking" | "writing")[];
      groupIds: string[];
      direction: ExpressionQuizDirection;
    }) => {
      setStarting(true);
      setError(null);
      try {
        const session = await startExpressionRecallQuiz({
          language,
          direction: filters.direction,
          ...(filters.purposeFilter.length > 0 ? { purposeFilter: filters.purposeFilter } : {}),
          ...(filters.groupIds.length > 0 ? { groupIds: filters.groupIds } : {}),
        });
        setQuiz(session);
        setPhase("quiz");
      } catch (err) {
        setError(String(err));
      } finally {
        setStarting(false);
      }
    },
    [language]
  );

  if (phase === "loading" || starting) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-amber-400 border-t-transparent" />
      </div>
    );
  }

  if (phase === "unreachable") {
    return (
      <QuizRecoveryState
        error
        onRetry={() => setAttempt((n) => n + 1)}
        onHome={onBack}
      />
    );
  }

  if (phase === "quiz" && quiz) {
    return (
      <ExpressionRecallTaking
        language={language}
        session={quiz}
        onComplete={onBack}
        onStartNew={() => {
          setQuiz(null);
          setPhase("setup");
        }}
      />
    );
  }

  return (
    <>
      {error && (
        <div className="mx-auto max-w-2xl p-4">
          <div className="rounded border border-red-700 bg-red-900/30 p-3">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        </div>
      )}
      <ExpressionRecallFilterModal language={language} onStart={handleStart} onClose={onBack} />
    </>
  );
}
