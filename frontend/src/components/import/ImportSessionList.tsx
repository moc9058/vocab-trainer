import { useI18n } from "../../i18n/context";
import type { ImportSessionSummary } from "../../types";

interface Props {
  sessions: ImportSessionSummary[];
  loading: boolean;
  onResume: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onNew: () => void;
  /** How many items each article quiz would ask — the pools span EVERY listed article,
   *  not the row they sit under, which is why they live in the header. */
  quizCounts: { a: number; b: number };
  /** Absent when the host didn't wire quiz navigation; the buttons are then hidden. */
  onQuiz?: (category: "A" | "B") => void;
}

/** Landing screen when unfinished imports exist — picking one back up is the
 *  common case, so it leads and "new article" sits beside it. */
export default function ImportSessionList({
  sessions,
  loading,
  onResume,
  onDelete,
  onNew,
  quizCounts,
  onQuiz,
}: Props) {
  const { t } = useI18n();

  // Same colours as the destination rail's dots — indigo is the Group A lesson group,
  // amber the Group B study set — so the buttons read as "drill THAT" without a legend.
  function QuizButton({ category, count }: { category: "A" | "B"; count: number }) {
    return (
      <button
        onClick={() => onQuiz?.(category)}
        disabled={count === 0}
        // Both class strings are spelled out because Tailwind scans source text —
        // an interpolated `border-${hue}-600` is never generated.
        className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          category === "A"
            ? "border-indigo-600 text-indigo-300 hover:bg-indigo-900/30"
            : "border-amber-600 text-amber-300 hover:bg-amber-900/30"
        }`}
      >
        {category === "A" ? t("importQuizA") : t("importQuizB")}
        <span className="ml-1.5 font-mono text-[11px] opacity-70">{count}</span>
      </button>
    );
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-3xl px-3 py-4 sm:p-6">
        <header className="mb-5">
          <h2 className="text-base font-bold text-gray-100 sm:text-lg">{t("importTitle")}</h2>
          <p className="mt-1 text-xs text-gray-400 sm:text-sm">{t("importDescription")}</p>
          <button
            onClick={onNew}
            className="mt-3 w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 sm:mt-4 sm:w-auto"
          >
            ＋ {t("importNewSession")}
          </button>

          {/* Review, not intake — so it is separated from "new import" by a rule. The pool
              spans every article below, which is why one pair of buttons sits here rather
              than a pair on each row. */}
          {onQuiz && (
            <div className="mt-4 border-t border-gray-700/70 pt-3">
              <p className="mb-2 text-[11px] text-gray-500">{t("importQuizHint")}</p>
              <div className="flex gap-2">
                <QuizButton category="A" count={quizCounts.a} />
                <QuizButton category="B" count={quizCounts.b} />
              </div>
            </div>
          )}
        </header>

        {loading && <p className="text-sm text-gray-500">…</p>}

        {!loading && sessions.length === 0 && (
          <p className="rounded-xl border border-dashed border-gray-700 px-4 py-8 text-center text-sm text-gray-500">
            {t("importNoSessions")}
          </p>
        )}

        <ul className="space-y-2">
          {sessions.map((s) => {
            const pct = s.totalCount > 0 ? (s.registeredCount / s.totalCount) * 100 : 0;
            return (
              <li
                key={s.id}
                className="rounded-xl border border-gray-700/70 bg-gray-800/50 p-3 sm:p-4"
              >
                {/* Title gets the full width on a phone; the meta and the two
                    actions drop to a second line rather than crushing it. */}
                <button onClick={() => onResume(s.id)} className="block w-full text-left">
                  <p className="truncate text-sm text-gray-100">{s.title}</p>
                  <p className="mt-0.5 text-[11px] text-gray-500">
                    {new Date(s.updatedAt).toLocaleString()}
                  </p>
                </button>
                <div className="mt-2 flex items-center gap-3">
                  <span className="shrink-0 font-mono text-xs text-gray-400">
                    {s.registeredCount}/{s.totalCount}
                  </span>
                  <button
                    onClick={() => onResume(s.id)}
                    className="ml-auto shrink-0 rounded-lg border border-indigo-600 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-900/30"
                  >
                    {t("importResume")}
                  </button>
                  <button
                    onClick={() => onDelete(s.id)}
                    className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-gray-600 hover:text-red-400"
                    title={t("importDeleteSession")}
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-gray-900">
                  <div
                    className="h-full rounded-full bg-indigo-500 transition-[width]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
