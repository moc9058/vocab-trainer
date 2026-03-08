import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getSessionDetails } from "../api/quiz";
import type { QuizSession } from "../types";

interface SessionDetailProps {
  sessionId: string;
}

export default function SessionDetail({ sessionId }: SessionDetailProps) {
  const { t } = useI18n();
  const [session, setSession] = useState<QuizSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSession(null);
    setError(null);
    getSessionDetails(sessionId)
      .then(setSession)
      .catch((err) => setError(err.message));
  }, [sessionId]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-red-500">{error}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-4 text-2xl font-bold text-gray-800">
        {t("sessionDetails")}
      </h2>

      <div className="mb-6 grid grid-cols-2 gap-4 rounded-lg bg-gray-50 p-4 sm:grid-cols-4">
        <div>
          <span className="text-sm text-gray-500">{t("language")}</span>
          <p className="font-medium capitalize">{session.language}</p>
        </div>
        <div>
          <span className="text-sm text-gray-500">{t("date")}</span>
          <p className="font-medium">
            {new Date(session.startedAt).toLocaleDateString()}
          </p>
        </div>
        <div>
          <span className="text-sm text-gray-500">{t("status")}</span>
          <p className="font-medium">
            {session.status === "completed" ? t("completed") : t("inProgress")}
          </p>
        </div>
        <div>
          <span className="text-sm text-gray-500">{t("score")}</span>
          <p className="font-medium">
            {session.score.correct}/{session.score.total}
          </p>
        </div>
      </div>

      <h3 className="mb-3 text-lg font-semibold text-gray-700">
        {t("questions")}
      </h3>
      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                {t("term")}
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                {t("expectedAnswer")}
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">
                {t("result")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {session.questions.map((q) => (
              <tr key={q.wordId} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-800">{q.term}</td>
                <td className="px-4 py-3 text-gray-800">{q.expectedAnswer}</td>
                <td className="px-4 py-3">
                  {q.userCorrect === undefined ? (
                    <span className="text-gray-400">{t("unanswered")}</span>
                  ) : q.userCorrect ? (
                    <span className="font-medium text-green-600">
                      {t("correct")}
                    </span>
                  ) : (
                    <span className="font-medium text-red-600">
                      {t("incorrect")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
