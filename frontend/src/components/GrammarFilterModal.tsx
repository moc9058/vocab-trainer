import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getGrammarGroups } from "../api/grammar";
import type { GrammarGroup } from "../types";
import { isWeightValid, parseWeightInput } from "../utils/weightInput";

interface Props {
  language: string;
  onStart: (filters: { groupIds: string[]; groupWeights: Record<string, number> }) => void;
  onClose: () => void;
}

export default function GrammarFilterModal({ language, onStart, onClose }: Props) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<GrammarGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [groupWeights, setGroupWeights] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGrammarGroups(language)
      .then((gs) => {
        setGroups(gs);
        // Pre-select all groups by default (mirrors word quiz filter)
        setSelectedGroupIds(new Set(gs.map((g) => g.id)));
        setGroupWeights(Object.fromEntries(gs.map((g) => [g.id, "1"])));
      })
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [language]);

  const hasInvalidGroupWeight = [...selectedGroupIds].some((id) => !isWeightValid(groupWeights[id], 1));

  function toggleGroup(id: string) {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = groups.length > 0 && selectedGroupIds.size === groups.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t("selectGrammarGroups")}
        </h2>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-4">
            {groups.length === 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-medium text-gray-300">{t("grammarGroups")}</h3>
                <p className="text-sm text-gray-500">No groups yet. The quiz will use all grammar items.</p>
              </div>
            ) : (
              <details open>
                <summary className="mb-2 flex items-center justify-between cursor-pointer select-none">
                  <h3 className="text-sm font-medium text-gray-300">
                    {t("grammarGroups")} ({selectedGroupIds.size}/{groups.length})
                  </h3>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      if (allSelected) setSelectedGroupIds(new Set());
                      else setSelectedGroupIds(new Set(groups.map((g) => g.id)));
                    }}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    {allSelected ? t("clearAll") : t("selectAll")}
                  </button>
                </summary>
                <div className="space-y-1">
                  {groups.map((g) => {
                    const weightInvalid = selectedGroupIds.has(g.id) && !isWeightValid(groupWeights[g.id], 1);
                    return (
                      <label
                        key={g.id}
                        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedGroupIds.has(g.id)}
                          onChange={() => toggleGroup(g.id)}
                          className="accent-blue-600"
                        />
                        <span className="flex-1">{g.name}</span>
                        {selectedGroupIds.has(g.id) && (
                          <input
                            type="number"
                            min={1}
                            value={groupWeights[g.id] ?? "1"}
                            title={t("groupWeightHint")}
                            aria-label={t("groupWeight")}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              setGroupWeights((prev) => ({ ...prev, [g.id]: e.target.value }));
                            }}
                            className={`w-12 shrink-0 rounded border bg-gray-700 px-1 py-0.5 text-xs text-gray-100 focus:outline-none ${
                              weightInvalid
                                ? "border-red-500 focus:border-red-400"
                                : "border-gray-600 focus:border-blue-400"
                            }`}
                          />
                        )}
                        <span className="text-xs text-gray-500 shrink-0 w-8 text-right">{g.grammarIds.length}</span>
                      </label>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        )}
        {hasInvalidGroupWeight && (
          <p className="mt-1 text-xs text-red-400">{t("groupWeightRequiredHint")}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() =>
              onStart({
                // No groups selected = quiz the entire pool (server-side default behavior).
                groupIds: [...selectedGroupIds],
                groupWeights: Object.fromEntries(
                  [...selectedGroupIds].map((id) => [id, Math.max(1, Math.floor(parseWeightInput(groupWeights[id]) ?? 1))])
                ),
              })
            }
            disabled={loading || hasInvalidGroupWeight}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {t("startGrammarQuiz")}
          </button>
        </div>
      </div>
    </div>
  );
}
