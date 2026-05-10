import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getFilters, getGroups } from "../api/vocab";
import type { WordGroup } from "../types";

interface Props {
  language: string;
  onStart: (filters: { topics: string[]; categories: string[]; levels: string[]; groupIds: string[] }) => void;
  onClose: () => void;
  startLabel?: string;
  groupCountMode?: "all" | "flagged";
  flaggedWordIds?: Set<string> | null;
}

function AndDivider() {
  return (
    <>
      {/* Vertical divider on desktop */}
      <div className="hidden md:flex flex-col items-center justify-center px-1 flex-shrink-0">
        <div className="flex-1 w-px bg-gray-700" />
        <span className="text-xs font-bold text-gray-500 bg-gray-750 py-1.5 px-2 rounded border border-gray-600 my-2 select-none">
          AND
        </span>
        <div className="flex-1 w-px bg-gray-700" />
      </div>
      {/* Horizontal divider on mobile */}
      <div className="flex md:hidden items-center gap-2 py-1 flex-shrink-0">
        <div className="flex-1 h-px bg-gray-700" />
        <span className="text-xs font-bold text-gray-500 bg-gray-750 py-1 px-2 rounded border border-gray-600 select-none">
          AND
        </span>
        <div className="flex-1 h-px bg-gray-700" />
      </div>
    </>
  );
}

export default function QuizFilterModal({
  language,
  onStart,
  onClose,
  startLabel,
  groupCountMode = "all",
  flaggedWordIds,
}: Props) {
  const { t } = useI18n();
  const [allLevels, setAllLevels] = useState<string[]>([]);
  const [allTopics, setAllTopics] = useState<string[]>([]);
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<WordGroup[]>([]);
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set());
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(new Set());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([getFilters(language), getGroups(language)])
      .then(([filtersResult, groupsResult]) => {
        if (filtersResult.status === "fulfilled") {
          const { levels, topics, categories } = filtersResult.value;
          setAllLevels(levels);
          setAllTopics(topics);
          setAllCategories(categories);
        }
        if (groupsResult.status === "fulfilled") {
          setAllGroups(groupsResult.value);
          setSelectedGroupIds(new Set(groupsResult.value.map((g: WordGroup) => g.id)));
        }
      })
      .finally(() => setLoading(false));
  }, [language]);

  function toggle(set: Set<string>, setFn: (s: Set<string>) => void, value: string) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setFn(next);
  }

  function toggleAll(all: string[], selected: Set<string>, setFn: (s: Set<string>) => void) {
    setFn(selected.size === all.length ? new Set() : new Set(all));
  }

  const hasSelection =
    selectedLevels.size > 0 || selectedTopics.size > 0 || selectedCategories.size > 0 || selectedGroupIds.size > 0;

  const visibleColumns = [
    allLevels.length > 0 ? "levels" : null,
    allTopics.length > 0 ? "topics" : null,
    allCategories.length > 0 ? "categories" : null,
    "groups",
  ].filter(Boolean);

  function groupWordCount(group: WordGroup): string | number {
    if (groupCountMode === "flagged") {
      return flaggedWordIds ? group.wordIds.filter((id) => flaggedWordIds.has(id)).length : "...";
    }
    return group.wordIds.length;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t("selectFilters")}
        </h2>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : (
          <div className="flex flex-col md:flex-row flex-1 gap-0 overflow-hidden">
            {/* Levels column */}
            {allLevels.length > 0 && (
              <>
                <div className="flex-1 flex flex-col min-w-0 min-h-0">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-sm font-medium text-gray-300">{t("levelsColumn")}</h3>
                    <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded select-none">OR</span>
                    <button
                      onClick={() => toggleAll(allLevels, selectedLevels, setSelectedLevels)}
                      className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                    >
                      {selectedLevels.size === allLevels.length ? t("clearAll") : t("selectAll")}
                    </button>
                  </div>
                  <ul className="flex-1 overflow-y-auto space-y-1">
                    {allLevels.map((level) => (
                      <li key={level}>
                        <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedLevels.has(level)}
                            onChange={() => toggle(selectedLevels, setSelectedLevels, level)}
                            className="accent-blue-600"
                          />
                          {level}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
                {visibleColumns.length > 1 && <AndDivider />}
              </>
            )}

            {/* Topics column */}
            {allTopics.length > 0 && (
              <>
                <div className="flex-1 flex flex-col min-w-0 min-h-0">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-sm font-medium text-gray-300">{t("topicsColumn")}</h3>
                    <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded select-none">OR</span>
                    <button
                      onClick={() => toggleAll(allTopics, selectedTopics, setSelectedTopics)}
                      className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                    >
                      {selectedTopics.size === allTopics.length ? t("clearAll") : t("selectAll")}
                    </button>
                  </div>
                  <ul className="flex-1 overflow-y-auto space-y-1">
                    {allTopics.map((topic) => (
                      <li key={topic}>
                        <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedTopics.has(topic)}
                            onChange={() => toggle(selectedTopics, setSelectedTopics, topic)}
                            className="accent-blue-600"
                          />
                          {topic}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
                <AndDivider />
              </>
            )}

            {/* Categories column */}
            {allCategories.length > 0 && (
              <>
                <div className="flex-1 flex flex-col min-w-0 min-h-0">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-sm font-medium text-gray-300">{t("grammarColumn")}</h3>
                    <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded select-none">OR</span>
                    <button
                      onClick={() => toggleAll(allCategories, selectedCategories, setSelectedCategories)}
                      className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                    >
                      {selectedCategories.size === allCategories.length ? t("clearAll") : t("selectAll")}
                    </button>
                  </div>
                  <ul className="flex-1 overflow-y-auto space-y-1">
                    {allCategories.map((cat) => (
                      <li key={cat}>
                        <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedCategories.has(cat)}
                            onChange={() => toggle(selectedCategories, setSelectedCategories, cat)}
                            className="accent-blue-600"
                          />
                          {cat}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
                <AndDivider />
              </>
            )}

            {/* Groups column — always shown */}
            <div className="flex-1 flex flex-col min-w-0 min-h-0">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-medium text-gray-300">{t("groups")}</h3>
                <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded select-none">OR</span>
                {allGroups.length > 0 && (
                  <button
                    onClick={() => toggleAll(allGroups.map((g) => g.id), selectedGroupIds, setSelectedGroupIds)}
                    className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                  >
                    {selectedGroupIds.size === allGroups.length ? t("clearAll") : t("selectAll")}
                  </button>
                )}
              </div>
              {allGroups.length === 0 ? (
                <p className="text-xs text-gray-500 px-2">{t("noGroupsHint")}</p>
              ) : (
                <ul className="flex-1 overflow-y-auto space-y-1">
                  {allGroups.map((group) => (
                    <li key={group.id}>
                      <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedGroupIds.has(group.id)}
                          onChange={() => toggle(selectedGroupIds, setSelectedGroupIds, group.id)}
                          className="accent-blue-600"
                        />
                        <span className="flex-1 min-w-0 truncate">{group.name}</span>
                        <span className="text-xs text-gray-500 shrink-0">{groupWordCount(group)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {!loading && visibleColumns.length > 1 && (
          <p className="mt-3 text-xs text-gray-500">{t("filterAndOrHint")}</p>
        )}
        {!hasSelection && !loading && (
          <p className="mt-1 text-xs text-gray-400">{t("allWordsHint")}</p>
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
                topics: [...selectedTopics],
                categories: [...selectedCategories],
                levels: [...selectedLevels],
                groupIds: [...selectedGroupIds],
              })
            }
            disabled={loading}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {startLabel ?? t("startQuiz")}
          </button>
        </div>
      </div>
    </div>
  );
}
