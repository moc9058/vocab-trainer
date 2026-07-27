import { useI18n } from "../../i18n/context";
import type { ImportSessionSummary } from "../../types";

interface Props {
  sessions: ImportSessionSummary[];
  loading: boolean;
  onResume: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onNew: () => void;
}

/** Landing screen when unfinished imports exist — picking one back up is the
 *  common case, so it leads and "new article" sits beside it. */
export default function ImportSessionList({
  sessions,
  loading,
  onResume,
  onDelete,
  onNew,
}: Props) {
  const { t } = useI18n();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-lg font-bold text-gray-100">{t("importTitle")}</h2>
            <p className="mt-1 text-sm text-gray-400">{t("importDescription")}</p>
          </div>
          <button
            onClick={onNew}
            className="ml-auto rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            ＋ {t("importNewSession")}
          </button>
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
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => onResume(s.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-sm text-gray-100">{s.title}</p>
                    <p className="mt-0.5 text-[11px] text-gray-500">
                      {new Date(s.updatedAt).toLocaleString()}
                    </p>
                  </button>
                  <span className="font-mono text-xs text-gray-400">
                    {s.registeredCount}/{s.totalCount}
                  </span>
                  <button
                    onClick={() => onResume(s.id)}
                    className="rounded-lg border border-indigo-600 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-900/30"
                  >
                    {t("importResume")}
                  </button>
                  <button
                    onClick={() => onDelete(s.id)}
                    className="rounded-lg px-2 py-1.5 text-xs text-gray-600 hover:text-red-400"
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
