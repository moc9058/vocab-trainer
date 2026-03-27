import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { fetchJson } from "../api/client";
import { getCurrentSession } from "../api/quiz";
import type { QuizSession } from "../types";

interface LanguageInfo {
  filename: string;
  language: string;
  wordCount: number;
}

interface Props {
  onResume: (session: QuizSession) => void;
  onStartNew: () => void;
  onBrowse: () => void;
  onFlaggedReview: () => void;
  onGrammarQuiz: () => void;
  onBrowseGrammar: () => void;
  onAddWord: () => void;
  onAddGrammar: () => void;
}

export default function EmptyState({ onResume, onStartNew, onBrowse, onFlaggedReview, onGrammarQuiz, onBrowseGrammar, onAddWord, onAddGrammar }: Props) {
  const { t } = useI18n();
  const [inProgressSessions, setInProgressSessions] = useState<
    { session: QuizSession; displayName: string }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const languages = await fetchJson<LanguageInfo[]>("/api/languages/");
        const results: { session: QuizSession; displayName: string }[] = [];
        for (const lang of languages) {
          const key = lang.filename.replace(/\.json$/, "");
          const session = await getCurrentSession(key);
          if (session && session.status === "in-progress") {
            results.push({ session, displayName: lang.language });
          }
        }
        if (!cancelled) setInProgressSessions(results);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("welcome")}</h2>

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : inProgressSessions.length > 0 ? (
        <div className="w-full max-w-lg space-y-3">
          {inProgressSessions.map(({ session, displayName }) => (
            <button
              key={session.sessionId}
              onClick={() => onResume(session)}
              className="w-full rounded-xl border border-blue-700 bg-blue-900/30 px-5 py-4 text-left hover:border-blue-500 hover:bg-blue-800/40 transition-colors"
            >
              <p className="font-semibold text-blue-300">{t("resumePreviousQuiz")}</p>
              <p className="mt-1 text-sm text-blue-400">
                {displayName} — {session.score.correct} / {session.wordIds?.length ?? session.questions.length} {t("questionsAnswered")}
              </p>
            </button>
          ))}
        </div>
      ) : null}

      <div className="w-full max-w-lg space-y-6">
        <section className="rounded-xl bg-gray-800/60 p-4 sm:p-5">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            {t("sectionVocabulary")}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              onClick={onStartNew}
              className="sm:col-span-2 rounded-lg bg-blue-600 px-5 py-3 text-center font-medium text-white hover:bg-blue-500 transition-colors"
            >
              {t("startWordQuiz")}
            </button>
            <button
              onClick={onBrowse}
              className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
            >
              {t("browseWords")}
            </button>
            <button
              onClick={onAddWord}
              className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
            >
              {t("smartAddWord")}
            </button>
            <button
              onClick={onFlaggedReview}
              className="sm:col-span-2 rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
            >
              {t("reviewFlagged")}
            </button>
          </div>
        </section>

        <section className="rounded-xl bg-gray-800/60 p-4 sm:p-5">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            {t("sectionGrammar")}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              onClick={onGrammarQuiz}
              className="sm:col-span-2 rounded-lg bg-emerald-600 px-5 py-3 text-center font-medium text-white hover:bg-emerald-500 transition-colors"
            >
              {t("grammarQuiz")}
            </button>
            <button
              onClick={onBrowseGrammar}
              className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
            >
              {t("browseGrammar")}
            </button>
            <button
              onClick={onAddGrammar}
              className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
            >
              {t("addGrammar")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
