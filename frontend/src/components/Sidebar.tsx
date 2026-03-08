import { useI18n } from "../i18n/context";
import type { QuizSessionSummary } from "../types";

interface SidebarProps {
  history: QuizSessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function Sidebar({ history, selectedId, onSelect }: SidebarProps) {
  const { t } = useI18n();

  return (
    <aside className="flex h-full w-72 flex-col border-r border-gray-200 bg-gray-50">
      <h2 className="border-b border-gray-200 px-4 py-3 text-lg font-semibold text-gray-700">
        {t("quizHistory")}
      </h2>
      <div className="flex-1 overflow-y-auto">
        {history.map((session) => (
          <button
            key={session.sessionId}
            onClick={() => onSelect(session.sessionId)}
            className={`w-full border-b border-gray-100 px-4 py-3 text-left transition hover:bg-blue-50 ${
              selectedId === session.sessionId
                ? "bg-blue-100 border-l-4 border-l-blue-500"
                : ""
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-800 capitalize">
                {session.language}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  session.status === "completed"
                    ? "bg-green-100 text-green-700"
                    : "bg-yellow-100 text-yellow-700"
                }`}
              >
                {session.status === "completed" ? t("completed") : t("inProgress")}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-sm text-gray-500">
              <span>{new Date(session.startedAt).toLocaleDateString()}</span>
              <span>
                {t("score")}: {session.score.correct}/{session.score.total}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
