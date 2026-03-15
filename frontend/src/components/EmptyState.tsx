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
}

export default function EmptyState({ onResume, onStartNew, onBrowse }: Props) {
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

  const answered = (s: QuizSession) =>
    s.questions.filter((q) => q.userCorrect !== undefined).length;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 p-4 sm:p-8">
      <h2 className="text-xl sm:text-2xl font-bold text-gray-800">{t("welcome")}</h2>

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : inProgressSessions.length > 0 ? (
        <div className="w-full max-w-md space-y-3">
          {inProgressSessions.map(({ session, displayName }) => (
            <button
              key={session.sessionId}
              onClick={() => onResume(session)}
              className="w-full rounded-xl border border-blue-200 bg-blue-50 px-5 py-4 text-left hover:border-blue-400 hover:bg-blue-100 transition-colors"
            >
              <p className="font-semibold text-blue-800">{t("resumePreviousQuiz")}</p>
              <p className="mt-1 text-sm text-blue-600">
                {displayName} — {answered(session)} / {session.questions.length} {t("questionsAnswered")}
              </p>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400">{t("noActiveQuiz")}</p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={onStartNew}
          className="rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-700"
        >
          {t("startQuiz")}
        </button>
        <button
          onClick={onBrowse}
          className="rounded-lg border border-gray-300 px-6 py-2 text-gray-700 hover:bg-gray-100"
        >
          {t("browseWords")}
        </button>
      </div>
    </div>
  );
}
