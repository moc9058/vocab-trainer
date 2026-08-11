import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/context";
import { getGroups } from "../api/vocab";
import { getGrammarGroups } from "../api/grammar";
import { getFlaggedWordIds } from "../api/flagged";
import {
  categoryGroups,
  type WordGroup,
  type GrammarGroup,
  type GroupCategory,
  type MixWeightConfig,
} from "../types";
import { isWeightValid, parseWeightInput, scaleWeightRecord } from "../utils/weightInput";
import {
  categoryDomainWeights,
  foldMixWeights,
  serializeGroupWeightDraft,
  scopedGroups,
  type MixWeightDraft,
  type QuizGroupScope,
} from "../utils/quizGroupScope";

export interface CombinedQuizFilters {
  domainWeights: { word: number; grammar: number };
  /** Mixed quiz only: the three-level ratios `domainWeights`/`groupWeights` were folded from,
   *  carried so the mid-session ⚖ panel can show them back. See `MixWeightConfig`. */
  mixWeights?: MixWeightConfig;
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

const CATEGORY_KEYS = ["A", "B"] as const;
const DOMAIN_KEYS = ["word", "grammar"] as const;

/** Tailwind can't build class names at runtime, so each accent is spelled out. */
const ACCENT = {
  blue: {
    heading: "text-blue-300",
    section: "border-blue-900/60",
    checkbox: "accent-blue-600",
    focus: "focus:border-blue-400",
    action: "text-blue-400 hover:text-blue-300",
  },
  emerald: {
    heading: "text-emerald-300",
    section: "border-emerald-900/60",
    checkbox: "accent-emerald-600",
    focus: "focus:border-emerald-400",
    action: "text-emerald-400 hover:text-emerald-300",
  },
} as const;

type Accent = keyof typeof ACCENT;

/**
 * One domain's group checklist with per-group weights. Extracted because the mixed quiz needs
 * it FOUR times (A-word, A-grammar, B-word, B-grammar) where the single-category setups need
 * it twice, and the two copies had already drifted apart (the grammar list had no scroll cap
 * below `md`, so a long list pushed the footer off a phone).
 *
 * The open/shut flag is local state seeded from `defaultOpen` rather than a bare `<details open>`:
 * React keeps writing that attribute back, so an uncontrolled `open` fights the user's clicks.
 */
function GroupChecklist<T extends { id: string; name: string; category?: GroupCategory }>({
  title,
  groups,
  selected,
  onToggle,
  onToggleAll,
  weights,
  onWeightChange,
  countOf,
  accent,
  defaultOpen,
  emptyHint,
}: {
  title: string;
  groups: T[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  weights: Record<string, string>;
  onWeightChange: (id: string, value: string) => void;
  countOf: (group: T) => string | number;
  accent: Accent;
  defaultOpen: boolean;
  emptyHint: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const a = ACCENT[accent];

  if (groups.length === 0) {
    return (
      <div>
        <h4 className="mb-1 text-sm font-medium text-gray-300">{title}</h4>
        <p className="px-2 text-xs text-gray-500">{emptyHint}</p>
      </div>
    );
  }

  const ids = groups.map((g) => g.id);
  const selectedHere = ids.filter((id) => selected.has(id)).length;

  return (
    <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="mb-2 flex cursor-pointer select-none items-center gap-2">
        <h4 className="text-sm font-medium text-gray-300">
          {title} ({selectedHere}/{groups.length})
        </h4>
        <span className="select-none rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-500">OR</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            onToggleAll(ids);
          }}
          className={`ml-auto text-xs ${a.action}`}
        >
          {selectedHere === groups.length ? t("clearAll") : t("selectAll")}
        </button>
      </summary>
      <ul className="max-h-56 space-y-1 overflow-y-auto md:max-h-48">
        {groups.map((group) => {
          const isSelected = selected.has(group.id);
          const weightInvalid = isSelected && !isWeightValid(weights[group.id], 0);
          return (
            <li key={group.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm text-gray-300 hover:bg-gray-700 sm:py-1">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(group.id)}
                  className={`h-4 w-4 shrink-0 ${a.checkbox}`}
                />
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                {isSelected && (
                  <input
                    type="number"
                    min={0}
                    value={weights[group.id] ?? "1"}
                    title={t("groupWeightHint")}
                    aria-label={t("groupWeight")}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onWeightChange(group.id, e.target.value)}
                    className={`w-16 shrink-0 rounded border bg-gray-700 px-1 py-1 text-base text-gray-100 focus:outline-none sm:w-12 sm:py-0.5 sm:text-xs ${
                      weightInvalid ? "border-red-500 focus:border-red-400" : `border-gray-600 ${a.focus}`
                    }`}
                  />
                )}
                <span className="w-8 shrink-0 text-right text-xs text-gray-500">{countOf(group)}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** A domain's header row (name + its weight) followed by its group checklist, or an em-dash
 *  when the weight is 0 — the established way this modal says "this bucket is switched off". */
function DomainBlock({
  label,
  accent,
  weight,
  onWeightChange,
  active,
  trailing,
  children,
}: {
  label: string;
  accent: Accent;
  weight: string;
  onWeightChange: (v: string) => void;
  active: boolean;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <h3 className={`text-sm font-semibold ${ACCENT[accent].heading}`}>{label}</h3>
        <DomainWeightInput
          value={weight}
          onChange={onWeightChange}
          label={`${label} ${t("groupWeight")}`}
          invalid={parseWeightInput(weight) === null}
        />
        {trailing}
      </div>
      {active ? children : <p className="px-1 text-xs text-gray-500">—</p>}
    </div>
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
  // Mixed quiz only: each category gets its OWN word:grammar ratio. A single global pair
  // could not say "Group B grammar-heavy, Group A vocabulary-heavy", which is the whole point
  // of drilling a lesson subset against the wider library. `wordWeight`/`grammarWeight` above
  // stay the only domain inputs for the single-category scopes.
  const [mixDomain, setMixDomain] = useState<MixWeightDraft["domain"]>({
    A: { word: "1", grammar: "1" },
    B: { word: "1", grammar: "1" },
  });
  // Group lists start folded on a phone — read once at mount, since a resize mid-setup should
  // not reach in and reopen lists the user just closed.
  const [wideViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches
  );

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

  // Scoped to the ids passed in, not the whole selection: in mixed mode each checklist shows
  // one category, so its select-all must leave the other category's picks alone.
  function toggleAllIn(ids: string[], selected: Set<string>, setFn: (s: Set<string>) => void) {
    const allOn = ids.every((id) => selected.has(id));
    const next = new Set(selected);
    for (const id of ids) {
      if (allOn) next.delete(id);
      else next.add(id);
    }
    setFn(next);
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

  const mixDraft: MixWeightDraft = { category: { A: categoryAWeight, B: categoryBWeight }, domain: mixDomain };
  // Cheap (linear in the group count) and needed by both the validity checks and `buildFilters`,
  // so it is recomputed per render rather than memoized against six changing inputs.
  const folded = isMixed
    ? foldMixWeights({
        draft: mixDraft,
        wordGroups: allWordGroups,
        selectedWord: selectedWordGroupIds,
        wordRaw: wordGroupWeights,
        grammarGroups: allGrammarGroups,
        selectedGrammar: selectedGrammarGroupIds,
        grammarRaw: grammarGroupWeights,
      })
    : null;

  // In mixed mode a domain is live when the FOLD leaves it positive — its two categories may
  // each contribute, and a category with nothing selected there contributes nothing.
  const wordDomainActive = folded
    ? (parseWeightInput(folded.domain.word) ?? 0) > 0
    : (wordWeightNum ?? 0) > 0;
  const grammarDomainActive = folded
    ? (parseWeightInput(folded.domain.grammar) ?? 0) > 0
    : (grammarWeightNum ?? 0) > 0;
  // Already-correct: blank = feature off; a number (incl. 0) activates the top-level bucket.
  const correctWeightActive = correctWeightDraft.trim() !== "";
  const correctWeightNum = parseWeightInput(correctWeightDraft);
  const correctDomainActive = correctWeightActive && (correctWeightNum ?? 0) > 0;
  const correctWeightInvalid = correctWeightActive && !isWeightValid(correctWeightDraft, 0);
  const hasInvalidDomainWeight = isMixed
    ? CATEGORY_KEYS.some((cat) => DOMAIN_KEYS.some((k) => parseWeightInput(mixDomain[cat][k]) === null))
    : wordWeightNum === null || grammarWeightNum === null;
  const hasInvalidWordGroupWeight =
    wordDomainActive && [...selectedWordGroupIds].some((id) => !isWeightValid(wordGroupWeights[id], 0));
  const hasInvalidGrammarGroupWeight =
    grammarDomainActive && [...selectedGrammarGroupIds].some((id) => !isWeightValid(grammarGroupWeights[id], 0));

  function buildFilters(): CombinedQuizFilters {
    // Each competing set is normalized independently (scaled to integers + GCD-reduced): the
    // word/grammar/already-correct domains merge together, while each domain's group weights
    // compete only among themselves.
    // Mixed: the three-level form is folded down to these same two knobs first, so the
    // normalization below is untouched — only its inputs differ. See `foldMixWeights`.
    const domainRaw: Record<string, string> = folded
      ? { word: folded.domain.word, grammar: folded.domain.grammar }
      : { word: wordWeight, grammar: grammarWeight };
    if (correctWeightActive) domainRaw.correct = correctWeightDraft;
    const d = scaleWeightRecord(domainRaw);
    const weightsFor = (
      groups: { id: string; category?: GroupCategory }[],
      selected: Set<string>,
      raw: Record<string, string>,
      foldedGroupWeights: Record<string, string> | null
    ) =>
      scaleWeightRecord(
        foldedGroupWeights ??
          Object.fromEntries(
            groups.filter((g) => selected.has(g.id)).map((g) => [g.id, raw[g.id] ?? "1"])
          )
      );
    // Send ids in `allGroups` order, NOT Set-iteration order: a Set reorders a group to the end
    // when it is unchecked and rechecked, which would break the B-first rule the mixed quiz
    // relies on. Deterministic for the single-category scopes too.
    const orderedIds = (groups: { id: string }[], selected: Set<string>) =>
      groups.filter((g) => selected.has(g.id)).map((g) => g.id);
    const p = categoryDomainWeights(mixDraft);
    return {
      domainWeights: { word: d.word, grammar: d.grammar },
      ...(isMixed
        ? {
            mixWeights: {
              category: {
                A: parseWeightInput(categoryAWeight) ?? 0,
                B: parseWeightInput(categoryBWeight) ?? 0,
              },
              // The raw per-category pairs, NOT the cross-scaled `p` — this is what the ⚖
              // panel shows back, and the user typed "3 : 1", not "18 : 6".
              domain: {
                A: {
                  word: parseWeightInput(mixDomain.A.word) ?? 0,
                  grammar: parseWeightInput(mixDomain.A.grammar) ?? 0,
                },
                B: {
                  word: parseWeightInput(mixDomain.B.word) ?? 0,
                  grammar: parseWeightInput(mixDomain.B.grammar) ?? 0,
                },
              },
              groups: {
                word: serializeGroupWeightDraft(selectedWordGroupIds, wordGroupWeights),
                grammar: serializeGroupWeightDraft(selectedGrammarGroupIds, grammarGroupWeights),
              },
            } satisfies MixWeightConfig,
          }
        : {}),
      ...(correctWeightActive ? { correctWeight: d.correct } : {}),
      word: {
        topics: [],
        categories: [],
        levels: [],
        groupIds: orderedIds(allWordGroups, selectedWordGroupIds),
        groupWeights: weightsFor(
          allWordGroups,
          selectedWordGroupIds,
          wordGroupWeights,
          folded?.wordGroupWeights ?? null
        ),
        flaggedOnly: showFlaggedToggle ? flaggedScope : false,
      },
      grammar: {
        groupIds: orderedIds(allGrammarGroups, selectedGrammarGroupIds),
        groupWeights: weightsFor(
          allGrammarGroups,
          selectedGrammarGroupIds,
          grammarGroupWeights,
          folded?.grammarGroupWeights ?? null
        ),
      },
    };
  }

  /** Groups of one category in one domain — the unit both the mixed layout and its
   *  per-bucket validation are expressed in. */
  function bucketGroups(cat: GroupCategory, domain: "word" | "grammar") {
    return domain === "word"
      ? categoryGroups(allWordGroups, cat)
      : categoryGroups(allGrammarGroups, cat);
  }

  function bucketHasSelection(cat: GroupCategory, domain: "word" | "grammar") {
    const selected = domain === "word" ? selectedWordGroupIds : selectedGrammarGroupIds;
    return bucketGroups(cat, domain).some((g) => selected.has(g.id));
  }

  /** A mixed bucket is live only if BOTH its category and its domain weight are positive. */
  function bucketActive(cat: GroupCategory, domain: "word" | "grammar") {
    const catWeight = parseWeightInput(cat === "A" ? categoryAWeight : categoryBWeight) ?? 0;
    return catWeight > 0 && (parseWeightInput(mixDomain[cat][domain]) ?? 0) > 0;
  }

  const allZero = !wordDomainActive && !grammarDomainActive && !correctDomainActive;
  // Outside the plain Group A quiz the pool IS the group selection: an empty word selection
  // falls back to the whole library and an empty grammar selection to every grammar item in
  // the language, so require at least one group per active domain.
  // Mixed checks this per (category, domain): "Group B grammar is weighted but no Group B
  // grammar group is ticked" is the real mistake, and the coarse per-domain check misses it
  // whenever the OTHER category has something selected. A bucket with no groups to offer at
  // all is not an error — it shows the inline `noGroupsHint` and simply contributes nothing.
  const missingGroupSelection = isMixed
    ? CATEGORY_KEYS.some((cat) =>
        DOMAIN_KEYS.some(
          (k) =>
            bucketActive(cat, k) && bucketGroups(cat, k).length > 0 && !bucketHasSelection(cat, k)
        )
      )
    : groupCategory !== "A" &&
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
        <p className="mb-3 text-xs text-gray-500">
          {isMixed ? t("categoryDomainWeightHint") : t("domainWeightHint")}
        </p>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : (
          <div className="flex-1 space-y-4 overflow-y-auto">
            {isMixed ? (
              /* ===== Mixed A+B: category first, then each category's own word/grammar split =====
                 The hierarchy on screen matches the one being configured (category → domain →
                 groups), which is the only reading under which a per-group number is guessable.
                 NOTE the render order (A above B) is presentation only — `orderedIds` still emits
                 `allWordGroups` order, which `scopedGroups` returns B-FIRST so that a word sitting
                 in both categories counts against B in the backend's first-wins membership. */
              CATEGORY_KEYS.map((cat) => {
                const catWeight = cat === "A" ? categoryAWeight : categoryBWeight;
                const setCatWeight = cat === "A" ? setCategoryAWeight : setCategoryBWeight;
                const catActive = (parseWeightInput(catWeight) ?? 0) > 0;
                return (
                  <details
                    key={cat}
                    open
                    className={`rounded-lg border bg-gray-800/60 ${
                      cat === "B" ? "border-amber-900/60" : "border-indigo-900/60"
                    }`}
                  >
                    <summary className="flex cursor-pointer select-none items-center gap-3 p-3">
                      <h3
                        className={`text-sm font-semibold ${
                          cat === "B" ? "text-amber-300" : "text-indigo-300"
                        }`}
                      >
                        {t(cat === "B" ? "categoryBLabel" : "categoryALabel")}
                      </h3>
                      {/* stopPropagation, not preventDefault: the click must not reach the
                          <summary> (which would fold the section), but the input keeps its own
                          default behaviour — preventDefault would disable the spinner arrows. */}
                      <span title={t("categoryWeightHint")} onClick={(e) => e.stopPropagation()}>
                        <DomainWeightInput
                          value={catWeight}
                          onChange={setCatWeight}
                          label={`${t(cat === "B" ? "categoryBLabel" : "categoryALabel")} ${t("groupWeight")}`}
                          invalid={!isWeightValid(catWeight, 0)}
                        />
                      </span>
                    </summary>
                    <div className="space-y-3 px-3 pb-3">
                      {!catActive ? (
                        <p className="px-1 text-xs text-gray-500">—</p>
                      ) : (
                        DOMAIN_KEYS.map((k) => (
                          <DomainBlock
                            key={k}
                            label={t(k === "word" ? "sectionVocabulary" : "sectionGrammar")}
                            accent={k === "word" ? "blue" : "emerald"}
                            weight={mixDomain[cat][k]}
                            onWeightChange={(v) =>
                              setMixDomain((prev) => ({ ...prev, [cat]: { ...prev[cat], [k]: v } }))
                            }
                            active={bucketActive(cat, k)}
                          >
                            {k === "word" ? (
                              <GroupChecklist
                                title={t("groups")}
                                groups={categoryGroups(allWordGroups, cat)}
                                selected={selectedWordGroupIds}
                                onToggle={(id) => toggle(selectedWordGroupIds, setSelectedWordGroupIds, id)}
                                onToggleAll={(ids) =>
                                  toggleAllIn(ids, selectedWordGroupIds, setSelectedWordGroupIds)
                                }
                                weights={wordGroupWeights}
                                onWeightChange={(id, v) =>
                                  setWordGroupWeights((prev) => ({ ...prev, [id]: v }))
                                }
                                countOf={wordGroupCount}
                                accent="blue"
                                defaultOpen={wideViewport}
                                emptyHint={t("noGroupsHint")}
                              />
                            ) : (
                              <GroupChecklist
                                title={t("grammarGroups")}
                                groups={categoryGroups(allGrammarGroups, cat)}
                                selected={selectedGrammarGroupIds}
                                onToggle={(id) =>
                                  toggle(selectedGrammarGroupIds, setSelectedGrammarGroupIds, id)
                                }
                                onToggleAll={(ids) =>
                                  toggleAllIn(ids, selectedGrammarGroupIds, setSelectedGrammarGroupIds)
                                }
                                weights={grammarGroupWeights}
                                onWeightChange={(id, v) =>
                                  setGrammarGroupWeights((prev) => ({ ...prev, [id]: v }))
                                }
                                countOf={(g) => g.grammarIds.length}
                                accent="emerald"
                                defaultOpen={wideViewport}
                                emptyHint={t("noGrammarGroupsHint")}
                              />
                            )}
                          </DomainBlock>
                        ))
                      )}
                    </div>
                  </details>
                );
              })
            ) : (
              /* ===== Single category (Group A quiz / Group B quiz): domain first, as before ===== */
              <>
                <section className={`rounded-lg border ${ACCENT.blue.section} bg-gray-800/60 p-3`}>
                  <DomainBlock
                    label={t("sectionVocabulary")}
                    accent="blue"
                    weight={wordWeight}
                    onWeightChange={setWordWeight}
                    active={wordDomainActive}
                    trailing={
                      showFlaggedToggle && (
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
                      )
                    }
                  >
                    <GroupChecklist
                      title={t("groups")}
                      groups={allWordGroups}
                      selected={selectedWordGroupIds}
                      onToggle={(id) => toggle(selectedWordGroupIds, setSelectedWordGroupIds, id)}
                      onToggleAll={(ids) => toggleAllIn(ids, selectedWordGroupIds, setSelectedWordGroupIds)}
                      weights={wordGroupWeights}
                      onWeightChange={(id, v) => setWordGroupWeights((prev) => ({ ...prev, [id]: v }))}
                      countOf={wordGroupCount}
                      accent="blue"
                      defaultOpen={wideViewport}
                      emptyHint={t("noGroupsHint")}
                    />
                  </DomainBlock>
                </section>

                <section className={`rounded-lg border ${ACCENT.emerald.section} bg-gray-800/60 p-3`}>
                  <DomainBlock
                    label={t("sectionGrammar")}
                    accent="emerald"
                    weight={grammarWeight}
                    onWeightChange={setGrammarWeight}
                    active={grammarDomainActive}
                  >
                    <GroupChecklist
                      title={t("grammarGroups")}
                      groups={allGrammarGroups}
                      selected={selectedGrammarGroupIds}
                      onToggle={(id) => toggle(selectedGrammarGroupIds, setSelectedGrammarGroupIds, id)}
                      onToggleAll={(ids) =>
                        toggleAllIn(ids, selectedGrammarGroupIds, setSelectedGrammarGroupIds)
                      }
                      weights={grammarGroupWeights}
                      onWeightChange={(id, v) => setGrammarGroupWeights((prev) => ({ ...prev, [id]: v }))}
                      countOf={(g) => g.grammarIds.length}
                      accent="emerald"
                      defaultOpen={wideViewport}
                      emptyHint={t("noGrammarGroupsHint")}
                    />
                  </DomainBlock>
                </section>
              </>
            )}
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
