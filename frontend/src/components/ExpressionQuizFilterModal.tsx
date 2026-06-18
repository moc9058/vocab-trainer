import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getExpressionGroups } from "../api/expressions";
import type { ExpressionGroup } from "../types";

interface Props {
  language: string;
  onStart: (filters: { purposeFilter: ("speaking" | "writing")[]; groupIds: string[] }) => void;
  onClose: () => void;
}

export default function ExpressionQuizFilterModal({ language, onStart, onClose }: Props) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<ExpressionGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [purposeSpeaking, setPurposeSpeaking] = useState(true);
  const [purposeWriting, setPurposeWriting] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getExpressionGroups(language)
      .then((gs) => {
        setGroups(gs);
        setSelectedGroupIds(new Set(gs.map((g) => g.id)));
      })
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [language]);

  function toggleGroup(id: string) {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = groups.length > 0 && selectedGroupIds.size === groups.length;

  const purposeFilter: ("speaking" | "writing")[] = [
    ...(purposeSpeaking ? (["speaking"] as const) : []),
    ...(purposeWriting ? (["writing"] as const) : []),
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t("startExpressionQuiz")}
        </h2>

        <div className="flex-1 overflow-y-auto space-y-5">
          {/* Purpose filter */}
          <div>
            <p className="text-sm font-medium text-gray-300 mb-2">{t("expressionPurpose")}</p>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={purposeSpeaking}
                  onChange={(e) => setPurposeSpeaking(e.target.checked)}
                  className="accent-orange-500"
                />
                {t("purposeSpeaking")}
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={purposeWriting}
                  onChange={(e) => setPurposeWriting(e.target.checked)}
                  className="accent-orange-500"
                />
                {t("purposeWriting")}
              </label>
            </div>
          </div>

          {/* Group filter */}
          {!loading && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-300">{t("groups")}</p>
                {groups.length > 0 && (
                  <button
                    onClick={() => {
                      if (allSelected) setSelectedGroupIds(new Set());
                      else setSelectedGroupIds(new Set(groups.map((g) => g.id)));
                    }}
                    className="text-xs text-orange-400 hover:text-orange-300"
                  >
                    {allSelected ? t("clearAll") : t("selectAll")}
                  </button>
                )}
              </div>
              {groups.length === 0 ? (
                <p className="text-sm text-gray-500">No groups yet. The quiz will use all expressions.</p>
              ) : (
                <div className="space-y-1">
                  {groups.map((g) => (
                    <label
                      key={g.id}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedGroupIds.has(g.id)}
                        onChange={() => toggleGroup(g.id)}
                        className="accent-orange-500"
                      />
                      <span className="flex-1">{g.name}</span>
                      <span className="text-xs text-gray-500">{g.expressionIds.length}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() =>
              onStart({ purposeFilter, groupIds: [...selectedGroupIds] })
            }
            disabled={loading || (!purposeSpeaking && !purposeWriting)}
            className="rounded-lg bg-orange-600 px-4 py-1.5 text-sm text-white hover:bg-orange-500 disabled:opacity-50"
          >
            {t("startExpressionQuiz")}
          </button>
        </div>
      </div>
    </div>
  );
}
