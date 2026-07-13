import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getFilters, getGroups } from "../api/vocab";
import { getGrammarGroups } from "../api/grammar";
import { getFlaggedWordIds } from "../api/flagged";
import type { WordGroup, GrammarGroup } from "../types";
import { isWeightValid, parseWeightInput } from "../utils/weightInput";

export interface CombinedQuizFilters {
  domainWeights: { word: number; grammar: number };
  word: {
    topics: string[];
    categories: string[];
    levels: string[];
    groupIds: string[];
    groupWeights: Record<string, number>;
    flaggedOnly: boolean;
  };
  grammar: {
    groupIds: string[];
    groupWeights: Record<string, number>;
  };
}

interface Props {
  language: string;
  onStart: (filters: CombinedQuizFilters) => void;
  onClose: () => void;
}

function ColumnDivider() {
  return (
    <>
      <div className="hidden md:flex flex-col items-center justify-center px-1 flex-shrink-0">
        <div className="flex-1 w-px bg-gray-700" />
        <span className="text-xs font-bold text-gray-500 bg-gray-750 py-1.5 px-2 rounded border border-gray-600 my-2 select-none">
          AND
        </span>
        <div className="flex-1 w-px bg-gray-700" />
      </div>
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

// Domain weight input: how often this domain (word/grammar) is drawn relative to the other.
// Kept as a raw string so the field can sit blank while retyping; a blank/invalid
// value blocks quiz generation instead of silently reverting to a default.
function DomainWeightInput({
  value,
  onChange,
  label,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  invalid: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-gray-400">
      <span className="select-none">×</span>
      <input
        type="number"
        min={0}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className={`w-14 rounded border bg-gray-700 px-1.5 py-0.5 text-sm text-gray-100 focus:outline-none ${
          invalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-blue-400"
        }`}
      />
    </label>
  );
}

// Plain multi-select column (levels / topics / categories).
function CheckboxColumn({
  title,
  items,
  selected,
  onToggle,
  onToggleAll,
  selectAllLabel,
  clearAllLabel,
}: {
  title: string;
  items: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onToggleAll: () => void;
  selectAllLabel: string;
  clearAllLabel: string;
}) {
  return (
    <div className="flex flex-col min-w-0 md:flex-1 md:min-h-0">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-medium text-gray-300">{title}</h3>
        <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded select-none">OR</span>
        <button onClick={onToggleAll} className="ml-auto text-xs text-blue-400 hover:text-blue-300">
          {selected.size === items.length ? clearAllLabel : selectAllLabel}
        </button>
      </div>
      <ul className="space-y-1 md:flex-1 md:overflow-y-auto">
        {items.map((item) => (
          <li key={item}>
            <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(item)}
                onChange={() => onToggle(item)}
                className="accent-blue-600"
              />
              {item}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function CombinedQuizFilterModal({ language, onStart, onClose }: Props) {
  const { t } = useI18n();
  const [wordWeight, setWordWeight] = useState("1");
  const [grammarWeight, setGrammarWeight] = useState("1");
  const [allLevels, setAllLevels] = useState<string[]>([]);
  const [allTopics, setAllTopics] = useState<string[]>([]);
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [allWordGroups, setAllWordGroups] = useState<WordGroup[]>([]);
  const [allGrammarGroups, setAllGrammarGroups] = useState<GrammarGroup[]>([]);
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set());
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(new Set());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [selectedWordGroupIds, setSelectedWordGroupIds] = useState<Set<string>>(new Set());
  const [wordGroupWeights, setWordGroupWeights] = useState<Record<string, string>>({});
  const [selectedGrammarGroupIds, setSelectedGrammarGroupIds] = useState<Set<string>>(new Set());
  const [grammarGroupWeights, setGrammarGroupWeights] = useState<Record<string, string>>({});
  const [flaggedScope, setFlaggedScope] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([getFilters(language), getGroups(language), getGrammarGroups(language)])
      .then(([filtersResult, groupsResult, grammarGroupsResult]) => {
        if (filtersResult.status === "fulfilled") {
          const { levels, topics, categories } = filtersResult.value;
          setAllLevels(levels);
          setAllTopics(topics);
          setAllCategories(categories);
        }
        if (groupsResult.status === "fulfilled") {
          setAllWordGroups(groupsResult.value);
          setSelectedWordGroupIds(new Set(groupsResult.value.map((g: WordGroup) => g.id)));
          setWordGroupWeights(Object.fromEntries(groupsResult.value.map((g: WordGroup) => [g.id, "1"])));
        }
        if (grammarGroupsResult.status === "fulfilled") {
          setAllGrammarGroups(grammarGroupsResult.value);
          setSelectedGrammarGroupIds(new Set(grammarGroupsResult.value.map((g) => g.id)));
          setGrammarGroupWeights(Object.fromEntries(grammarGroupsResult.value.map((g) => [g.id, "1"])));
        }
      })
      .finally(() => setLoading(false));
  }, [language]);

  useEffect(() => {
    getFlaggedWordIds(language)
      .then(({ wordIds }) => setFlaggedIds(new Set(wordIds)))
      .catch(() => setFlaggedIds(new Set()));
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

  function wordGroupCount(group: WordGroup): string | number {
    if (flaggedScope) {
      return flaggedIds ? group.wordIds.filter((id) => flaggedIds.has(id)).length : "...";
    }
    return group.wordIds.length;
  }

  // Domain weights: blank/invalid text blocks generation rather than falling back
  // to a default — 0 is a valid, intentional "skip this domain" value.
  const wordWeightNum = parseWeightInput(wordWeight);
  const grammarWeightNum = parseWeightInput(grammarWeight);
  const wordDomainActive = (wordWeightNum ?? 0) > 0;
  const grammarDomainActive = (grammarWeightNum ?? 0) > 0;
  const hasInvalidDomainWeight = wordWeightNum === null || grammarWeightNum === null;
  const hasInvalidWordGroupWeight =
    wordDomainActive && [...selectedWordGroupIds].some((id) => !isWeightValid(wordGroupWeights[id], 1));
  const hasInvalidGrammarGroupWeight =
    grammarDomainActive && [...selectedGrammarGroupIds].some((id) => !isWeightValid(grammarGroupWeights[id], 1));

  function buildFilters(): CombinedQuizFilters {
    return {
      domainWeights: {
        word: Math.max(0, Math.floor(wordWeightNum ?? 0)),
        grammar: Math.max(0, Math.floor(grammarWeightNum ?? 0)),
      },
      word: {
        topics: [...selectedTopics],
        categories: [...selectedCategories],
        levels: [...selectedLevels],
        groupIds: [...selectedWordGroupIds],
        groupWeights: Object.fromEntries(
          [...selectedWordGroupIds].map((id) => [id, Math.max(1, Math.floor(parseWeightInput(wordGroupWeights[id]) ?? 1))])
        ),
        flaggedOnly: flaggedScope,
      },
      grammar: {
        groupIds: [...selectedGrammarGroupIds],
        groupWeights: Object.fromEntries(
          [...selectedGrammarGroupIds].map((id) => [id, Math.max(1, Math.floor(parseWeightInput(grammarGroupWeights[id]) ?? 1))])
        ),
      },
    };
  }

  const bothZero = !wordDomainActive && !grammarDomainActive;
  const canStart =
    !bothZero && !hasInvalidDomainWeight && !hasInvalidWordGroupWeight && !hasInvalidGrammarGroupWeight;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl max-h-[85dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-100">{t("selectCombinedFilters")}</h2>
        </div>
        <p className="mb-3 text-xs text-gray-500">{t("domainWeightHint")}</p>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-4">
            {/* ===== Word section ===== */}
            <section className="rounded-lg border border-blue-900/60 bg-gray-800/60 p-3">
              <div className="mb-3 flex items-center gap-3">
                <h3 className="text-sm font-semibold text-blue-300">{t("sectionVocabulary")}</h3>
                <DomainWeightInput
                  value={wordWeight}
                  onChange={setWordWeight}
                  label={`${t("sectionVocabulary")} ${t("groupWeight")}`}
                  invalid={wordWeightNum === null}
                />
                <button
                  type="button"
                  onClick={() => setFlaggedScope((v) => !v)}
                  aria-pressed={flaggedScope}
                  className={`ml-auto rounded-md border px-2.5 py-1 text-xs font-medium ${
                    flaggedScope
                      ? "border-amber-500 bg-amber-600 text-white"
                      : "border-gray-600 bg-gray-700 text-gray-200 hover:bg-gray-600"
                  }`}
                >
                  ⚑ {t("limitToFlagged")}
                </button>
              </div>
              {!wordDomainActive ? (
                <p className="text-xs text-gray-500 px-1">—</p>
              ) : (
                <div className="flex flex-col md:flex-row gap-0">
                  {/* Word groups (with per-group weights) */}
                  <div className="flex flex-col min-w-0 md:flex-1 md:min-h-0">
                    {allWordGroups.length === 0 ? (
                      <>
                        <h4 className="mb-2 text-sm font-medium text-gray-300">{t("groups")}</h4>
                        <p className="text-xs text-gray-500 px-2">{t("noGroupsHint")}</p>
                      </>
                    ) : (
                      <details className="flex flex-col min-h-0 md:flex-1" open>
                        <summary className="flex items-center gap-2 mb-2 cursor-pointer select-none">
                          <h4 className="text-sm font-medium text-gray-300">
                            {t("groups")} ({selectedWordGroupIds.size}/{allWordGroups.length})
                          </h4>
                          <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded select-none">OR</span>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              toggleAll(allWordGroups.map((g) => g.id), selectedWordGroupIds, setSelectedWordGroupIds);
                            }}
                            className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                          >
                            {selectedWordGroupIds.size === allWordGroups.length ? t("clearAll") : t("selectAll")}
                          </button>
                        </summary>
                        <ul className="space-y-1 md:max-h-48 md:overflow-y-auto">
                          {allWordGroups.map((group) => {
                            const weightInvalid = selectedWordGroupIds.has(group.id) && !isWeightValid(wordGroupWeights[group.id], 1);
                            return (
                              <li key={group.id}>
                                <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={selectedWordGroupIds.has(group.id)}
                                    onChange={() => toggle(selectedWordGroupIds, setSelectedWordGroupIds, group.id)}
                                    className="accent-blue-600"
                                  />
                                  <span className="flex-1 min-w-0 truncate">{group.name}</span>
                                  {selectedWordGroupIds.has(group.id) && (
                                    <input
                                      type="number"
                                      min={1}
                                      value={wordGroupWeights[group.id] ?? "1"}
                                      title={t("groupWeightHint")}
                                      aria-label={t("groupWeight")}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => {
                                        setWordGroupWeights((prev) => ({ ...prev, [group.id]: e.target.value }));
                                      }}
                                      className={`w-12 shrink-0 rounded border bg-gray-700 px-1 py-0.5 text-xs text-gray-100 focus:outline-none ${
                                        weightInvalid
                                          ? "border-red-500 focus:border-red-400"
                                          : "border-gray-600 focus:border-blue-400"
                                      }`}
                                    />
                                  )}
                                  <span className="text-xs text-gray-500 shrink-0 w-8 text-right">{wordGroupCount(group)}</span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    )}
                  </div>

                  {allLevels.length > 0 && (
                    <>
                      <ColumnDivider />
                      <CheckboxColumn
                        title={t("levelsColumn")}
                        items={allLevels}
                        selected={selectedLevels}
                        onToggle={(v) => toggle(selectedLevels, setSelectedLevels, v)}
                        onToggleAll={() => toggleAll(allLevels, selectedLevels, setSelectedLevels)}
                        selectAllLabel={t("selectAll")}
                        clearAllLabel={t("clearAll")}
                      />
                    </>
                  )}
                  {allTopics.length > 0 && (
                    <>
                      <ColumnDivider />
                      <CheckboxColumn
                        title={t("topicsColumn")}
                        items={allTopics}
                        selected={selectedTopics}
                        onToggle={(v) => toggle(selectedTopics, setSelectedTopics, v)}
                        onToggleAll={() => toggleAll(allTopics, selectedTopics, setSelectedTopics)}
                        selectAllLabel={t("selectAll")}
                        clearAllLabel={t("clearAll")}
                      />
                    </>
                  )}
                  {allCategories.length > 0 && (
                    <>
                      <ColumnDivider />
                      <CheckboxColumn
                        title={t("grammarColumn")}
                        items={allCategories}
                        selected={selectedCategories}
                        onToggle={(v) => toggle(selectedCategories, setSelectedCategories, v)}
                        onToggleAll={() => toggleAll(allCategories, selectedCategories, setSelectedCategories)}
                        selectAllLabel={t("selectAll")}
                        clearAllLabel={t("clearAll")}
                      />
                    </>
                  )}
                </div>
              )}
            </section>

            {/* ===== Grammar section ===== */}
            <section className="rounded-lg border border-emerald-900/60 bg-gray-800/60 p-3">
              <div className="mb-3 flex items-center gap-3">
                <h3 className="text-sm font-semibold text-emerald-300">{t("sectionGrammar")}</h3>
                <DomainWeightInput
                  value={grammarWeight}
                  onChange={setGrammarWeight}
                  label={`${t("sectionGrammar")} ${t("groupWeight")}`}
                  invalid={grammarWeightNum === null}
                />
              </div>
              {!grammarDomainActive ? (
                <p className="text-xs text-gray-500 px-1">—</p>
              ) : (
                <div className="flex flex-col min-w-0">
                  {allGrammarGroups.length === 0 ? (
                    <>
                      <h4 className="mb-2 text-sm font-medium text-gray-300">{t("grammarGroups")}</h4>
                      <p className="text-xs text-gray-500 px-2">{t("noGrammarGroupsHint")}</p>
                    </>
                  ) : (
                    <details open>
                      <summary className="flex items-center gap-2 mb-2 cursor-pointer select-none">
                        <h4 className="text-sm font-medium text-gray-300">
                          {t("grammarGroups")} ({selectedGrammarGroupIds.size}/{allGrammarGroups.length})
                        </h4>
                        <span className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded select-none">OR</span>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            toggleAll(allGrammarGroups.map((g) => g.id), selectedGrammarGroupIds, setSelectedGrammarGroupIds);
                          }}
                          className="ml-auto text-xs text-blue-400 hover:text-blue-300"
                        >
                          {selectedGrammarGroupIds.size === allGrammarGroups.length ? t("clearAll") : t("selectAll")}
                        </button>
                      </summary>
                      <ul className="space-y-1 md:max-h-48 md:overflow-y-auto">
                        {allGrammarGroups.map((group) => {
                          const weightInvalid = selectedGrammarGroupIds.has(group.id) && !isWeightValid(grammarGroupWeights[group.id], 1);
                          return (
                            <li key={group.id}>
                              <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={selectedGrammarGroupIds.has(group.id)}
                                  onChange={() => toggle(selectedGrammarGroupIds, setSelectedGrammarGroupIds, group.id)}
                                  className="accent-emerald-600"
                                />
                                <span className="flex-1 min-w-0 truncate">{group.name}</span>
                                {selectedGrammarGroupIds.has(group.id) && (
                                  <input
                                    type="number"
                                    min={1}
                                    value={grammarGroupWeights[group.id] ?? "1"}
                                    title={t("groupWeightHint")}
                                    aria-label={t("groupWeight")}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      setGrammarGroupWeights((prev) => ({ ...prev, [group.id]: e.target.value }));
                                    }}
                                    className={`w-12 shrink-0 rounded border bg-gray-700 px-1 py-0.5 text-xs text-gray-100 focus:outline-none ${
                                      weightInvalid
                                        ? "border-red-500 focus:border-red-400"
                                        : "border-gray-600 focus:border-emerald-400"
                                    }`}
                                  />
                                )}
                                <span className="text-xs text-gray-500 shrink-0 w-8 text-right">{group.grammarIds.length}</span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

        {(hasInvalidDomainWeight || hasInvalidWordGroupWeight || hasInvalidGrammarGroupWeight) && (
          <p className="mt-1 text-xs text-red-400">{t("groupWeightRequiredHint")}</p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() => onStart(buildFilters())}
            disabled={loading || !canStart}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {t("startCombinedQuiz")}
          </button>
        </div>
      </div>
    </div>
  );
}
