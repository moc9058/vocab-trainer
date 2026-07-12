import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { answerGrammarQuestion } from "../api/grammar";
import { fetchJson } from "../api/client";
import RubyText from "./RubyText";
import type { GrammarQuizSession, Grammar } from "../types";

interface Props {
  session: GrammarQuizSession;
  onComplete: () => void;
  onStartNew: () => void;
}

export default function GrammarQuizTaking({ session, onComplete, onStartNew }: Props) {
  const { t } = useI18n();
  const { displayDefEntries, displayGrammarDefEntries } = useSettings();
  const [currentSession, setCurrentSession] = useState(session);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const idx = session.questions.findIndex((q) => q.userCorrect === undefined);
    return idx === -1 ? session.questions.length : idx;
  });
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [grammarCache, setGrammarCache] = useState<Map<string, Grammar>>(new Map());
  const [originalTotal] = useState(
    session.questions.filter((q) => q.userCorrect === undefined).length || session.questions.length
  );

  // Fetch grammar item details for showing statement/descriptions on answer reveal
  useEffect(() => {
    const ids = [...new Set(session.questions.map((q) => q.grammarId))];
    for (const id of ids) {
      if (!grammarCache.has(id)) {
        fetchJson<Grammar>(
          `/api/grammar/${encodeURIComponent(session.language)}/items/${encodeURIComponent(id)}`
        )
          .then((item) => {
            setGrammarCache((prev) => new Map(prev).set(id, item));
          })
          .catch(() => {});
      }
    }
  }, [session.questions, session.language]);

  const question =
    currentIndex < currentSession.questions.length ? currentSession.questions[currentIndex] : null;
  const isComplete = currentSession.status === "completed";
  const grammar = question ? grammarCache.get(question.grammarId) : null;

  async function handleGrade(correct: boolean) {
    if (!question || submitting) return;
    setSubmitting(true);
    try {
      const result = await answerGrammarQuestion({
        language: currentSession.language,
        grammarId: question.grammarId,
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
            onClick={() => {
              onComplete();
              onStartNew();
            }}
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
          {/* Reveal: descriptions */}
          {grammar && (
            <div className="w-full max-w-lg rounded-lg bg-gray-800 border border-gray-600 p-4">
              {grammar.descriptions?.map((d, di) => {
                const entries = displayDefEntries(d.text || {});
                const rows = entries.length > 0 ? entries : Object.entries(d.text || {});
                return (
                  <div key={di} className="mb-2 last:mb-0">
                    {d.partOfSpeech && (
                      <span className="mr-2 rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300">
                        {d.partOfSpeech}
                      </span>
                    )}
                    {rows.map(([lang, text]) => (
                      <p key={lang} className="text-sm text-gray-300 whitespace-pre-line">
                        <span className="text-xs text-gray-500">[{lang}] </span>
                        {text}
                      </p>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

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
