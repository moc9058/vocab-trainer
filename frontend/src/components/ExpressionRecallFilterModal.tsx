import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getExpressionGroups } from "../api/expressions";
import type { ExpressionGroup, ExpressionQuizDirection } from "../types";

interface Props {
  language: string;
  onStart: (filters: {
    purposeFilter: ("speaking" | "writing")[];
    groupIds: string[];
    direction: ExpressionQuizDirection;
  }) => void;
  onClose: () => void;
}

export default function ExpressionRecallFilterModal({ language, onStart, onClose }: Props) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<ExpressionGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [purposeSpeaking, setPurposeSpeaking] = useState(true);
  const [purposeWriting, setPurposeWriting] = useState(true);
  const [direction, setDirection] = useState<ExpressionQuizDirection>("phrase-to-context");
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
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl bg-gray-800 p-4 shadow-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t("startExpressionRecallQuiz")}
        </h2>

        <div className="flex-1 space-y-5 overflow-y-auto">
          {/* Direction — the one setting this quiz has that the writing quiz doesn't. */}
          <div>
            <p className="mb-2 text-sm font-medium text-gray-300">
              {t("expressionRecallDirection")}
            </p>
            <div className="space-y-1">
              {(
                [
                  ["phrase-to-context", t("directionPhraseToContext")],
                  ["context-to-phrase", t("directionContextToPhrase")],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
                >
                  <input
                    type="radio"
                    name="recall-direction"
                    checked={direction === value}
                    onChange={() => setDirection(value)}
                    className="accent-amber-500"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-gray-300">{t("expressionPurpose")}</p>
            <div className="flex gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={purposeSpeaking}
                  onChange={(e) => setPurposeSpeaking(e.target.checked)}
                  className="accent-amber-500"
                />
                {t("purposeSpeaking")}
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={purposeWriting}
                  onChange={(e) => setPurposeWriting(e.target.checked)}
                  className="accent-amber-500"
                />
                {t("purposeWriting")}
              </label>
            </div>
          </div>

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
                    className="text-xs text-amber-400 hover:text-amber-300"
                  >
                    {allSelected ? t("clearAll") : t("selectAll")}
                  </button>
                )}
              </div>
              {groups.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No groups yet. The quiz will use all expressions.
                </p>
              ) : (
                <div className="space-y-1">
                  {groups.map((g) => (
                    <label
                      key={g.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
                    >
                      <input
                        type="checkbox"
                        checked={selectedGroupIds.has(g.id)}
                        onChange={() => toggleGroup(g.id)}
                        className="accent-amber-500"
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
              onStart({ purposeFilter, groupIds: [...selectedGroupIds], direction })
            }
            disabled={loading || (!purposeSpeaking && !purposeWriting)}
            className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {t("startExpressionRecallQuiz")}
          </button>
        </div>
      </div>
    </div>
  );
}
