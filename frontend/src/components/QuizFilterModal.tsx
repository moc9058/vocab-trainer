import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getFilters, getGroups } from "../api/vocab";
import { getFlaggedWordIds } from "../api/flagged";
import { categoryGroups, type WordGroup } from "../types";
import { isWeightValid, parseWeightInput, scaleWeightRecord } from "../utils/weightInput";

export interface QuizFilters {
  topics: string[];
  categories: string[];
  levels: string[];
  groupIds: string[];
  groupWeights: Record<string, number>;
  /** Weight for the "already-correct" (mastered) bucket; undefined = feature off. */
  correctWeight?: number;
  flaggedOnly: boolean;
}

interface Props {
  language: string;
  onStart: (filters: QuizFilters) => void;
  onClose: () => void;
  startLabel?: string;
  groupCountMode?: "all" | "flagged";
  flaggedWordIds?: Set<string> | null;
  onPrint?: (filters: QuizFilters, count: number | null) => void;
  // When true, the modal shows a "flagged only" toggle that scopes the quiz pool to
  // flagged words (AND-combined with the other filters). Used by the standard quiz.
  showFlaggedScope?: boolean;
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
  onPrint,
  showFlaggedScope = false,
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
  const [groupWeights, setGroupWeights] = useState<Record<string, string>>({});
  // Blank = feature off (mastered words stay mixed in as usual). A number activates the
  // "already-correct" bucket: 0 excludes mastered words, higher reviews them more.
  const [correctWeightDraft, setCorrectWeightDraft] = useState<string>("");
  const [flaggedScope, setFlaggedScope] = useState<boolean>(false);
  const [internalFlaggedIds, setInternalFlaggedIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [printCount, setPrintCount] = useState<number>(30);
  const [printAllMode, setPrintAllMode] = useState<boolean>(false);

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
          // Word quiz draws from the Group A universe; Group B has its own quiz.
          const aGroups = categoryGroups(groupsResult.value as WordGroup[], "A");
          setAllGroups(aGroups);
          setSelectedGroupIds(new Set(aGroups.map((g: WordGroup) => g.id)));
          setGroupWeights(Object.fromEntries(aGroups.map((g: WordGroup) => [g.id, "1"])));
        }
      })
      .finally(() => setLoading(false));
  }, [language]);

  // For the standard quiz, fetch flagged word IDs so the "flagged only" toggle can scope
  // the pool and show flagged-only group counts.
  useEffect(() => {
    if (!showFlaggedScope) return;
    getFlaggedWordIds(language)
      .then(({ wordIds }) => setInternalFlaggedIds(new Set(wordIds)))
      .catch(() => setInternalFlaggedIds(new Set()));
  }, [showFlaggedScope, language]);

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

  // When the standard quiz's flagged toggle is on, use the locally-fetched flagged IDs;
  // otherwise honor the prop-driven mode (used by Flagged Review).
  const effectiveCountMode = showFlaggedScope ? (flaggedScope ? "flagged" : "all") : groupCountMode;
  const effectiveFlaggedIds = showFlaggedScope ? internalFlaggedIds : (flaggedWordIds ?? null);

  function groupWordCount(group: WordGroup): string | number {
    if (effectiveCountMode === "flagged") {
      return effectiveFlaggedIds ? group.wordIds.filter((id) => effectiveFlaggedIds.has(id)).length : "...";
    }
    return group.wordIds.length;
  }

  // Weight inputs only apply to the graded quiz (not Flagged Review); a blank
  // or invalid weight on a selected group blocks quiz generation entirely
  // rather than silently falling back to a default. Decimals are allowed (min 0).
  const correctWeightActive = showFlaggedScope && correctWeightDraft.trim() !== "";
  const correctWeightInvalid = correctWeightActive && !isWeightValid(correctWeightDraft, 0);
  const hasInvalidGroupWeight =
    (showFlaggedScope && [...selectedGroupIds].some((id) => !isWeightValid(groupWeights[id], 0))) ||
    correctWeightInvalid;

  function buildFilters(): QuizFilters {
    // Scale every graded-quiz weight (groups + already-correct) by one common factor so
    // decimals become integers while ratios are preserved (e.g. 10, 0.3 -> 100, 3).
    const raws: Record<string, string> = {};
    for (const id of selectedGroupIds) raws[`g:${id}`] = groupWeights[id] ?? "1";
    if (correctWeightActive) raws.__correct__ = correctWeightDraft;
    const scaled = scaleWeightRecord(raws);
    return {
      topics: [...selectedTopics],
      categories: [...selectedCategories],
      levels: [...selectedLevels],
      groupIds: [...selectedGroupIds],
      groupWeights: Object.fromEntries([...selectedGroupIds].map((id) => [id, scaled[`g:${id}`] ?? 1])),
      ...(correctWeightActive ? { correctWeight: scaled.__correct__ } : {}),
      flaggedOnly: showFlaggedScope ? flaggedScope : false,
    };
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl max-h-[85dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-100">
            {t("selectFilters")}
          </h2>
          <div className="flex items-center gap-2">
            {showFlaggedScope && (
              <label
                className="flex items-center gap-1.5 text-xs text-gray-300"
                title={t("alreadyCorrectHint")}
              >
                <span className="whitespace-nowrap">✅ {t("alreadyCorrect")}</span>
                <input
                  type="number"
                  min={0}
                  placeholder="—"
                  value={correctWeightDraft}
                  aria-label={t("alreadyCorrect")}
                  onChange={(e) => setCorrectWeightDraft(e.target.value)}
                  className={`w-14 rounded border bg-gray-700 px-1.5 py-0.5 text-xs text-gray-100 focus:outline-none ${
                    correctWeightInvalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-blue-400"
                  }`}
                />
              </label>
            )}
            {showFlaggedScope && (
              <button
                type="button"
                onClick={() => setFlaggedScope((v) => !v)}
                aria-pressed={flaggedScope}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                  flaggedScope
                    ? "border-amber-500 bg-amber-600 text-white"
                    : "border-gray-600 bg-gray-700 text-gray-200 hover:bg-gray-600"
                }`}
              >
                ⚑ {t("limitToFlagged")}
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : (
          <div className="flex flex-col md:flex-row flex-1 gap-0 overflow-y-auto md:overflow-hidden">
            {/* Groups column — always shown, first; each selected group has a weight */}
            <div className="flex flex-col min-w-0 md:flex-1 md:min-h-0">
              {allGroups.length === 0 ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-sm font-medium text-gray-300">{t("groups")}</h3>
                  </div>
                  <p className="text-xs text-gray-500 px-2">{t("noGroupsHint")}</p>
                </>
              ) : (
                <details className="flex flex-col min-h-0 md:flex-1" open>
                  <summary className="flex items-center gap-2 mb-2 cursor-pointer select-none">
                    <h3 className="text-sm font-medium text-gray-300">
                      {t("groups")} ({selectedGroupIds.size}/{allGroups.length})
                    </h3>
                    <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded select-none">OR</span>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        toggleAll(allGroups.map((g) => g.id), selectedGroupIds, setSelectedGroupIds);
                      }}
                      className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                    >
                      {selectedGroupIds.size === allGroups.length ? t("clearAll") : t("selectAll")}
                    </button>
                  </summary>
                  <ul className="space-y-1 md:flex-1 md:overflow-y-auto">
                    {allGroups.map((group) => {
                      const weightInvalid = showFlaggedScope && selectedGroupIds.has(group.id) && !isWeightValid(groupWeights[group.id], 0);
                      return (
                        <li key={group.id}>
                          <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedGroupIds.has(group.id)}
                              onChange={() => toggle(selectedGroupIds, setSelectedGroupIds, group.id)}
                              className="accent-blue-600"
                            />
                            <span className="flex-1 min-w-0 truncate">{group.name}</span>
                            {/* Per-group weight applies only to the graded quiz (not Flagged Review). */}
                            {showFlaggedScope && selectedGroupIds.has(group.id) && (
                              <input
                                type="number"
                                min={0}
                                value={groupWeights[group.id] ?? "1"}
                                title={t("groupWeightHint")}
                                aria-label={t("groupWeight")}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  setGroupWeights((prev) => ({ ...prev, [group.id]: e.target.value }));
                                }}
                                className={`w-12 shrink-0 rounded border bg-gray-700 px-1 py-0.5 text-xs text-gray-100 focus:outline-none ${
                                  weightInvalid
                                    ? "border-red-500 focus:border-red-400"
                                    : "border-gray-600 focus:border-blue-400"
                                }`}
                              />
                            )}
                            <span className="text-xs text-gray-500 shrink-0 w-8 text-right">{groupWordCount(group)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
            </div>

            {/* Levels column */}
            {allLevels.length > 0 && (
              <>
                <AndDivider />
                <div className="flex flex-col min-w-0 md:flex-1 md:min-h-0">
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
                  <ul className="space-y-1 md:flex-1 md:overflow-y-auto">
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
              </>
            )}

            {/* Topics column */}
            {allTopics.length > 0 && (
              <>
                <AndDivider />
                <div className="flex flex-col min-w-0 md:flex-1 md:min-h-0">
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
                  <ul className="space-y-1 md:flex-1 md:overflow-y-auto">
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
              </>
            )}

            {/* Categories column */}
            {allCategories.length > 0 && (
              <>
                <AndDivider />
                <div className="flex flex-col min-w-0 md:flex-1 md:min-h-0">
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
                  <ul className="space-y-1 md:flex-1 md:overflow-y-auto">
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
              </>
            )}
          </div>
        )}

        {!loading && visibleColumns.length > 1 && (
          <p className="mt-3 text-xs text-gray-500">{t("filterAndOrHint")}</p>
        )}
        {!hasSelection && !loading && (
          <p className="mt-1 text-xs text-gray-400">{t("allWordsHint")}</p>
        )}
        {hasInvalidGroupWeight && (
          <p className="mt-1 text-xs text-red-400">{t("groupWeightRequiredHint")}</p>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {onPrint && (
            <div className="mr-auto flex items-center gap-2 text-sm text-gray-300">
              <span>{t("worksheetCount")}</span>
              <input
                type="number"
                min={1}
                value={printAllMode ? "" : printCount}
                placeholder={printAllMode ? t("worksheetAll") : undefined}
                onChange={(e) => {
                  const next = Math.max(1, Number(e.target.value) || 1);
                  setPrintCount(next);
                  setPrintAllMode(false);
                }}
                disabled={printAllMode}
                className="w-20 rounded-md border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => setPrintAllMode((v) => !v)}
                aria-pressed={printAllMode}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                  printAllMode
                    ? "border-blue-500 bg-blue-600 text-white"
                    : "border-gray-600 bg-gray-700 text-gray-200 hover:bg-gray-600"
                }`}
              >
                {t("worksheetAll")}
              </button>
            </div>
          )}
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("cancel")}
          </button>
          {onPrint && (
            <button
              onClick={() => onPrint(buildFilters(), printAllMode ? null : printCount)}
              disabled={loading || (!printAllMode && printCount < 1) || hasInvalidGroupWeight}
              className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50"
            >
              {t("printWorksheet")}
            </button>
          )}
          <button
            onClick={() => onStart(buildFilters())}
            disabled={loading || hasInvalidGroupWeight}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {startLabel ?? t("startQuiz")}
          </button>
        </div>
      </div>
    </div>
  );
}
