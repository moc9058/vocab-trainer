import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getGroups } from "../api/vocab";
import { getGrammarGroups } from "../api/grammar";
import { getFlaggedWordIds } from "../api/flagged";
import { groupCategory as categoryOf, type WordGroup, type GrammarGroup, type GroupCategory } from "../types";
import { isWeightValid, parseWeightInput, scaleWeightRecord } from "../utils/weightInput";
import { applyCategoryRatio, scopedGroups, type QuizGroupScope } from "../utils/quizGroupScope";

export interface CombinedQuizFilters {
  domainWeights: { word: number; grammar: number };
  /** Top-level weight for the "already-correct" (mastered) bucket; undefined = feature off. */
  correctWeight?: number;
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
  /** Which meta-group bucket(s) to draw the pool from. Default "A" (the normal combined quiz). */
  groupCategory?: QuizGroupScope;
  /** The Group B quiz has no flag concept — hide the toggle and force `flaggedOnly: false`. */
  showFlaggedToggle?: boolean;
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
        className={`w-16 rounded border bg-gray-700 px-1.5 py-1 text-base text-gray-100 focus:outline-none sm:w-14 sm:py-0.5 sm:text-sm ${
          invalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-blue-400"
        }`}
      />
    </label>
  );
}

/** Which meta-group a row belongs to. Only rendered in the mixed quiz, where the list holds
 *  both; the single-category setups already say so in their title. */
function CategoryBadge({ category }: { category: GroupCategory }) {
  return (
    <span
      className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold leading-none ${
        category === "B" ? "bg-amber-900/60 text-amber-300" : "bg-indigo-900/60 text-indigo-300"
      }`}
    >
      {category}
    </span>
  );
}

export default function CombinedQuizFilterModal({
  language,
  onStart,
  onClose,
  groupCategory = "A",
  showFlaggedToggle = true,
}: Props) {
  const { t } = useI18n();
  const [wordWeight, setWordWeight] = useState("1");
  const [grammarWeight, setGrammarWeight] = useState("1");
  // Blank = feature off (mastered items stay mixed in). A number activates the top-level
  // "already-correct" bucket (peer to word/grammar): 0 excludes mastered items, higher reviews more.
  const [correctWeightDraft, setCorrectWeightDraft] = useState("");
  const [allWordGroups, setAllWordGroups] = useState<WordGroup[]>([]);
  const [allGrammarGroups, setAllGrammarGroups] = useState<GrammarGroup[]>([]);
  const [selectedWordGroupIds, setSelectedWordGroupIds] = useState<Set<string>>(new Set());
  const [wordGroupWeights, setWordGroupWeights] = useState<Record<string, string>>({});
  const [selectedGrammarGroupIds, setSelectedGrammarGroupIds] = useState<Set<string>>(new Set());
  const [grammarGroupWeights, setGrammarGroupWeights] = useState<Record<string, string>>({});
  const [flaggedScope, setFlaggedScope] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  // Mixed quiz only: how often the two meta-groups are drawn relative to each other.
  // 1:1 already leans hard on B, since B is a small subset of A and empties first.
  const isMixed = groupCategory === "AB";
  const [categoryAWeight, setCategoryAWeight] = useState("1");
  const [categoryBWeight, setCategoryBWeight] = useState("1");

  useEffect(() => {
    Promise.allSettled([getGroups(language), getGrammarGroups(language)])
      .then(([groupsResult, grammarGroupsResult]) => {
        if (groupsResult.status === "fulfilled") {
          const wg = scopedGroups(groupsResult.value as WordGroup[], groupCategory);
          setAllWordGroups(wg);
          setSelectedWordGroupIds(new Set(wg.map((g: WordGroup) => g.id)));
          setWordGroupWeights(Object.fromEntries(wg.map((g: WordGroup) => [g.id, "1"])));
        }
        if (grammarGroupsResult.status === "fulfilled") {
          const gg = scopedGroups(grammarGroupsResult.value as GrammarGroup[], groupCategory);
          setAllGrammarGroups(gg);
          setSelectedGrammarGroupIds(new Set(gg.map((g) => g.id)));
          setGrammarGroupWeights(Object.fromEntries(gg.map((g) => [g.id, "1"])));
        }
      })
      .finally(() => setLoading(false));
  }, [language, groupCategory]);

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
  // Already-correct: blank = feature off; a number (incl. 0) activates the top-level bucket.
  const correctWeightActive = correctWeightDraft.trim() !== "";
  const correctWeightNum = parseWeightInput(correctWeightDraft);
  const correctDomainActive = correctWeightActive && (correctWeightNum ?? 0) > 0;
  const correctWeightInvalid = correctWeightActive && !isWeightValid(correctWeightDraft, 0);
  const hasInvalidDomainWeight = wordWeightNum === null || grammarWeightNum === null;
  const hasInvalidWordGroupWeight =
    wordDomainActive && [...selectedWordGroupIds].some((id) => !isWeightValid(wordGroupWeights[id], 0));
  const hasInvalidGrammarGroupWeight =
    grammarDomainActive && [...selectedGrammarGroupIds].some((id) => !isWeightValid(grammarGroupWeights[id], 0));

  function buildFilters(): CombinedQuizFilters {
    // Each competing set is normalized independently (scaled to integers + GCD-reduced): the
    // word/grammar/already-correct domains merge together, while each domain's group weights
    // compete only among themselves.
    const domainRaw: Record<string, string> = { word: wordWeight, grammar: grammarWeight };
    if (correctWeightActive) domainRaw.correct = correctWeightDraft;
    const d = scaleWeightRecord(domainRaw);
    const catWeights = {
      A: (isMixed ? parseWeightInput(categoryAWeight) : 1) ?? 0,
      B: (isMixed ? parseWeightInput(categoryBWeight) : 1) ?? 0,
    };
    const weightsFor = (
      groups: { id: string; category?: GroupCategory }[],
      selected: Set<string>,
      raw: Record<string, string>
    ) =>
      scaleWeightRecord(
        isMixed
          ? applyCategoryRatio(groups, selected, raw, catWeights)
          : Object.fromEntries(
              groups.filter((g) => selected.has(g.id)).map((g) => [g.id, raw[g.id] ?? "1"])
            )
      );
    // Send ids in `allGroups` order, NOT Set-iteration order: a Set reorders a group to the end
    // when it is unchecked and rechecked, which would break the B-first rule the mixed quiz
    // relies on. Deterministic for the single-category scopes too.
    const orderedIds = (groups: { id: string }[], selected: Set<string>) =>
      groups.filter((g) => selected.has(g.id)).map((g) => g.id);
    return {
      domainWeights: { word: d.word, grammar: d.grammar },
      ...(correctWeightActive ? { correctWeight: d.correct } : {}),
      word: {
        topics: [],
        categories: [],
        levels: [],
        groupIds: orderedIds(allWordGroups, selectedWordGroupIds),
        groupWeights: weightsFor(allWordGroups, selectedWordGroupIds, wordGroupWeights),
        flaggedOnly: showFlaggedToggle ? flaggedScope : false,
      },
      grammar: {
        groupIds: orderedIds(allGrammarGroups, selectedGrammarGroupIds),
        groupWeights: weightsFor(allGrammarGroups, selectedGrammarGroupIds, grammarGroupWeights),
      },
    };
  }

  const allZero = !wordDomainActive && !grammarDomainActive && !correctDomainActive;
  // Outside the plain Group A quiz the pool IS the group selection: an empty word selection
  // falls back to the whole library and an empty grammar selection to every grammar item in
  // the language, so require at least one group per active domain.
  const missingGroupSelection =
    groupCategory !== "A" &&
    ((wordDomainActive && selectedWordGroupIds.size === 0) ||
      (grammarDomainActive && selectedGrammarGroupIds.size === 0));
  const categoryWeightsInvalid =
    isMixed &&
    (!isWeightValid(categoryAWeight, 0) ||
      !isWeightValid(categoryBWeight, 0) ||
      ((parseWeightInput(categoryAWeight) ?? 0) <= 0 && (parseWeightInput(categoryBWeight) ?? 0) <= 0));
  const canStart =
    !allZero &&
    !missingGroupSelection &&
    !categoryWeightsInvalid &&
    !hasInvalidDomainWeight &&
    !hasInvalidWordGroupWeight &&
    !hasInvalidGrammarGroupWeight &&
    !correctWeightInvalid;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl max-h-[85dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-100">
            {t(
              groupCategory === "B"
                ? "selectGroupBFilters"
                : isMixed
                  ? "selectMixedFilters"
                  : "selectCombinedFilters"
            )}
          </h2>
          {isMixed && (
            <div
              className="flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-900/40 px-2 py-1"
              title={t("categoryWeightHint")}
            >
              <span className="text-xs font-medium text-indigo-300">A</span>
              <DomainWeightInput
                value={categoryAWeight}
                onChange={setCategoryAWeight}
                label={`Group A ${t("groupWeight")}`}
                invalid={!isWeightValid(categoryAWeight, 0)}
              />
              <span className="select-none text-xs text-gray-500">⇄</span>
              <span className="text-xs font-medium text-amber-300">B</span>
              <DomainWeightInput
                value={categoryBWeight}
                onChange={setCategoryBWeight}
                label={`Group B ${t("groupWeight")}`}
                invalid={!isWeightValid(categoryBWeight, 0)}
              />
            </div>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-300" title={t("alreadyCorrectHint")}>
            <span className="whitespace-nowrap">✅ {t("alreadyCorrect")}</span>
            <input
              type="number"
              min={0}
              placeholder="—"
              value={correctWeightDraft}
              aria-label={t("alreadyCorrect")}
              onChange={(e) => setCorrectWeightDraft(e.target.value)}
              className={`w-16 rounded border bg-gray-700 px-1.5 py-1 text-base text-gray-100 focus:outline-none sm:w-14 sm:py-0.5 sm:text-xs ${
                correctWeightInvalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-indigo-400"
              }`}
            />
          </label>
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
                {showFlaggedToggle && (
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
                )}
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
                        <ul className="space-y-1 max-h-56 overflow-y-auto md:max-h-48">
                          {allWordGroups.map((group) => {
                            const weightInvalid = selectedWordGroupIds.has(group.id) && !isWeightValid(wordGroupWeights[group.id], 0);
                            return (
                              <li key={group.id}>
                                <label className="flex items-center gap-2 rounded px-2 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer sm:py-1">
                                  <input
                                    type="checkbox"
                                    checked={selectedWordGroupIds.has(group.id)}
                                    onChange={() => toggle(selectedWordGroupIds, setSelectedWordGroupIds, group.id)}
                                    className="h-4 w-4 shrink-0 accent-blue-600"
                                  />
                                  {isMixed && <CategoryBadge category={categoryOf(group)} />}
                                  <span className="flex-1 min-w-0 truncate">{group.name}</span>
                                  {selectedWordGroupIds.has(group.id) && (
                                    <input
                                      type="number"
                                      min={0}
                                      value={wordGroupWeights[group.id] ?? "1"}
                                      title={t("groupWeightHint")}
                                      aria-label={t("groupWeight")}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => {
                                        setWordGroupWeights((prev) => ({ ...prev, [group.id]: e.target.value }));
                                      }}
                                      className={`w-16 shrink-0 rounded border bg-gray-700 px-1 py-1 text-base text-gray-100 focus:outline-none sm:w-12 sm:py-0.5 sm:text-xs ${
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
                          const weightInvalid = selectedGrammarGroupIds.has(group.id) && !isWeightValid(grammarGroupWeights[group.id], 0);
                          return (
                            <li key={group.id}>
                              <label className="flex items-center gap-2 rounded px-2 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer sm:py-1">
                                <input
                                  type="checkbox"
                                  checked={selectedGrammarGroupIds.has(group.id)}
                                  onChange={() => toggle(selectedGrammarGroupIds, setSelectedGrammarGroupIds, group.id)}
                                  className="h-4 w-4 shrink-0 accent-emerald-600"
                                />
                                {isMixed && <CategoryBadge category={categoryOf(group)} />}
                                <span className="flex-1 min-w-0 truncate">{group.name}</span>
                                {selectedGrammarGroupIds.has(group.id) && (
                                  <input
                                    type="number"
                                    min={0}
                                    value={grammarGroupWeights[group.id] ?? "1"}
                                    title={t("groupWeightHint")}
                                    aria-label={t("groupWeight")}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      setGrammarGroupWeights((prev) => ({ ...prev, [group.id]: e.target.value }));
                                    }}
                                    className={`w-16 shrink-0 rounded border bg-gray-700 px-1 py-1 text-base text-gray-100 focus:outline-none sm:w-12 sm:py-0.5 sm:text-xs ${
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

        {(hasInvalidDomainWeight || hasInvalidWordGroupWeight || hasInvalidGrammarGroupWeight || correctWeightInvalid) && (
          <p className="mt-1 text-xs text-red-400">{t("groupWeightRequiredHint")}</p>
        )}
        {missingGroupSelection && (
          <p className="mt-1 text-xs text-amber-400">{t("groupBNeedsGroup")}</p>
        )}
        {categoryWeightsInvalid && (
          <p className="mt-1 text-xs text-red-400">{t("categoryWeightRequiredHint")}</p>
        )}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          <button
            onClick={onClose}
            className="w-full rounded-lg border border-gray-600 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 sm:w-auto sm:border-transparent sm:py-1.5"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() => onStart(buildFilters())}
            disabled={loading || !canStart}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:py-1.5"
          >
            {t(
              groupCategory === "B"
                ? "startGroupBQuiz"
                : isMixed
                  ? "startMixedQuiz"
                  : "startCombinedQuiz"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
