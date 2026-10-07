import { finishQuizSitting, normalizeQuizSitting } from "../utils/quizSitting";
import { applyMixedOperation, orderMixedQuestions, UNGROUPED_A } from "../utils/mixedOperations";
import { mixedCategoryProgress } from "../utils/mixedProgress";
import { getOutboxState } from "../utils/answerOutbox";
import { useState, useEffect, useRef, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP } from "../settings/defaults";
import {
  updateCombinedQuizWeights,
  type CombinedQuizVariant,
} from "../api/combined-quiz";
import { getGroups } from "../api/vocab";
import { getGrammarGroups } from "../api/grammar";
import { getFlaggedWordIds, flagWord, unflagWord } from "../api/flagged";
import { isWeightValid, parseWeightInput, scaleWeightRecord } from "../utils/weightInput";
import RubyText from "./RubyText";
import GrammarDescriptionsPanel from "./GrammarDescriptionsPanel";
import QuizLoadState from "./QuizLoadState";
import QuizSyncBadge from "./QuizSyncBadge";
import { useQuizPrefetch } from "../hooks/useQuizPrefetch";
import { useAnswerOutbox } from "../hooks/useAnswerOutbox";
import {
  applyCombinedAnswerLocally,
} from "../utils/quizLocal";
import {
  appendSessionReview,
  completeSessionReview,
  loadSessionReview,
  sessionReviewKey,
  unreviewedSessionQuestions,
} from "../utils/sessionReview";
import { categoryGroups, groupCategory as categoryOf } from "../types";
import {
  categoryDomainWeights,
  foldMixWeights,
  representedGroupIds,
  restoreGroupWeightDraft,
  serializeGroupWeightDraft,
  type MixWeightDraft,
} from "../utils/quizGroupScope";
import type {
  CombinedQuizSession,
  CombinedQuizQuestion,
  CombinedQuizWordQuestion,
  GroupCategory,
  MixWeightConfig,
} from "../types";

const VISIBLE_ANSWER_ITEMS = 4;
type QuizDomain = "word" | "grammar";
type ProgressSelection = { category?: GroupCategory; kind?: QuizDomain };
const QUIZ_DOMAINS = ["word", "grammar"] as const;
const CATEGORY_KEYS = ["A", "B"] as const;
/** Domain accents, shared by the progress pills and the weight editor. */
const DOMAIN_TONE: Record<QuizDomain, { pill: string; text: string; focus: string }> = {
  word: {
    pill: "bg-blue-900/40 text-blue-300 border-blue-700/50",
    text: "text-blue-300",
    focus: "focus:border-blue-400",
  },
  grammar: {
    pill: "bg-emerald-900/40 text-emerald-300 border-emerald-700/50",
    text: "text-emerald-300",
    focus: "focus:border-emerald-400",
  },
};
/** Reading preference, not session data: kept in localStorage so hiding the
 *  readings once holds for the next question, the next session and both quizzes. */
const EXAMPLE_PINYIN_PREF_KEY = "quizShowExamplePinyin";

/** Key for the Group B removal sets. Word and grammar ids live in different namespaces
 *  today (numeric vs `grammar-…`), but nothing enforces that — the OCR tool posts grammar
 *  with ids of its own making — so the kind is part of the key. */
const bKey = (kind: "word" | "grammar", refId: string) => `${kind}:${refId}`;

interface Props {
  session: CombinedQuizSession;
  onComplete: () => void;
  onBrowse: () => void;
  onStartNew: () => void;
  /** The mixed quiz swaps the "3" key from flag to
   *  "remove from Group B". Default "combined". */
  variant?: CombinedQuizVariant;
}

function TranslationDisplay({ translation }: { translation: string | Record<string, string> }) {
  const { displayExEntries } = useSettings();
  if (!translation) return null;
  if (typeof translation === "string") return <p className="text-sm text-gray-400">{translation}</p>;
  return (
    <>
      {displayExEntries(translation).map(([lang, text]) => (
        <p key={lang} className="text-sm text-gray-400">
          <span className="text-xs font-medium uppercase text-gray-500 mr-1">{lang}</span>{text}
        </p>
      ))}
    </>
  );
}

/** Anything the pinyin toggle can hide: per-segment ruby, or a whole-sentence
 *  reading (grammar examples carry one). */
interface ReadableExample {
  transliteration?: string;
  segments?: { transliteration?: string }[];
}

/** Whether a set of examples has any reading at all — the toggle is pointless
 *  otherwise, and a Japanese or Korean sentence never has one. */
function hasExampleReadings(examples: ReadableExample[]): boolean {
  return examples.some(
    (ex) => ex.transliteration?.trim() || ex.segments?.some((s) => s.transliteration?.trim())
  );
}

/**
 * The "Examples" heading, with the readings toggle sat on its right. It lives on
 * the examples card rather than in the quiz header because that is what it acts
 * on, and because the card is the one place on screen guaranteed to be in view
 * when the reader wants it. The button is omitted entirely when there is no
 * reading to hide.
 */
function ExamplesHeader({ showPinyin, onToggle }: { showPinyin: boolean; onToggle?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mb-2 flex items-center gap-2">
      <p className="min-w-0 flex-1 text-sm font-medium text-gray-400">{t("examples")}</p>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={showPinyin}
          // Generous vertical padding below `sm`: this sits among tappable
          // controls on a phone and needs a real target, not a text link.
          className={`shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs transition-colors sm:py-1 ${
            showPinyin
              ? "border-indigo-600/70 bg-indigo-950/40 text-indigo-200"
              : "border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200"
          }`}
        >
          {showPinyin ? t("hideExamplePinyin") : t("showExamplePinyin")}
        </button>
      )}
    </div>
  );
}

export default function CombinedQuizTaking({ session, onComplete, onBrowse, onStartNew, variant = "combined" }: Props) {
  // The Group B and mixed A+B quizzes both bind "3" to "retire this from Group B" — the
  // productive gesture once an item is memorized. Only the plain Group A quiz uses "3" to
  // flag a word, so flagging is skipped entirely in the other two.
  // The article quizzes ("importA"/"importB") are deliberately NOT in this list: they are
  // specified to match the plain Group A quiz, keeping the flag key and offering no
  // remove-from-Group-B, even for the Group B article drill.
  const usesGroupBControls = variant === "mixed";
  const { t } = useI18n();
  const { settings, displayDefEntries, displayGrammarDefEntries } = useSettings();
  // `currentSession.questions` is the single source of ORDER and is slim; word payloads and
  // grammar items live in the id-keyed prefetch cache and are merged in at render time.
  const [currentSession, setCurrentSession] = useState(() => normalizeQuizSitting(session));
  const [currentIndex, setCurrentIndex] = useState(() => {
    const firstUnanswered = currentSession.questions.findIndex((q) => q.userCorrect === undefined);
    return firstUnanswered === -1 ? currentSession.questions.length : firstUnanswered;
  });
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [showAllDefinitions, setShowAllDefinitions] = useState(false);
  const [showAllExamples, setShowAllExamples] = useState(false);
  const [showExamplePinyin, setShowExamplePinyin] = useState(
    () => localStorage.getItem(EXAMPLE_PINYIN_PREF_KEY) !== "0"
  );
  const toggleExamplePinyin = () =>
    setShowExamplePinyin((prev) => {
      localStorage.setItem(EXAMPLE_PINYIN_PREF_KEY, prev ? "0" : "1");
      return !prev;
    });
  // Grading is synchronous now; this only stops a double-tap grading the same card twice.
  const gradedIndexRef = useRef(-1);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [alreadyFlaggedIds, setAlreadyFlaggedIds] = useState<Set<string>>(new Set());
  // Mark now, commit with grading (or end-sitting) through the serial outbox.
  // Removed IDs hide the control locally; the sync badge reports pending/failed commits.
  const [pendingRemoveBIds, setPendingRemoveBIds] = useState<Set<string>>(new Set());
  const [removedFromBIds, setRemovedFromBIds] = useState<Set<string>>(new Set());
  const [groupNameMap, setGroupNameMap] = useState<Map<string, string>>(new Map());
  // Group metadata labels the weight editor and detailed progress rows.
  const [groupCategoryMap, setGroupCategoryMap] = useState<Map<string, GroupCategory>>(new Map());
  // Which items actually sit in a category-B group, per domain. The mixed A+B quiz draws
  // from the UNION of both categories, so most of its cards are A-only and must NOT offer
  // "remove from Group B" — the DELETE would remove nothing while the UI claimed success.
  // `null` = not known yet (still loading, or the groups fetch failed) and fails OPEN, so a
  // blip can't make the control disappear from the Group B quiz, where every card is in B.
  const [groupBIds, setGroupBIds] = useState<{ words: Set<string>; grammar: Set<string> } | null>(
    null
  );
  // The category-A home of every item, from the same fetch: the mixed quiz's refile must
  // know which A bucket a just-removed item belongs in. First A group wins — words are
  // A-exclusive anyway, and grammar (which may legally sit in several) stays deterministic.
  const [aGroupHome, setAGroupHome] = useState<{
    words: Map<string, string>;
    grammar: Map<string, string>;
  } | null>(null);
  const [actualAMembership, setActualAMembership] = useState<{ word: Record<string, string[]>; grammar: Record<string, string[]> }>({ word: {}, grammar: {} });
  const [originalTotal] = useState(() => session.initialTotal ?? session.questions.length);
  /** A random-order session has no buckets to weight — the whole union is one shuffle,
   *  and `PUT …/weights` rejects it — so the ⚖ control has nothing to offer. */
  const weightsAdjustable = !currentSession.randomOrder;
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [progressSelection, setProgressSelection] = useState<ProgressSelection | null>(null);
  const [domainDraft, setDomainDraft] = useState<{ word: string; grammar: string }>({ word: "1", grammar: "1" });
  const [wordWeightDraft, setWordWeightDraft] = useState<Record<string, string>>({});
  const [grammarWeightDraft, setGrammarWeightDraft] = useState<Record<string, string>>({});
  const [correctDraft, setCorrectDraft] = useState("");
  // Mixed quiz only: the three-level form. Seeded from `session.mixWeights`, which is stored
  // precisely because `domainWeights` cannot be un-folded back into these ratios.
  const [mixCategoryDraft, setMixCategoryDraft] = useState<{ A: string; B: string }>({ A: "1", B: "1" });
  const [mixDomainDraft, setMixDomainDraft] = useState<MixWeightDraft["domain"]>({
    A: { word: "1", grammar: "1" },
    B: { word: "1", grammar: "1" },
  });
  const [applyingWeights, setApplyingWeights] = useState(false);
  // Group lists in the panel start folded on a phone; read once, so a rotation mid-edit does
  // not reopen lists the user closed.
  const [wideViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches
  );
  // Durable End Session boundary; the variant is already encoded in `sessionId`.
  const reviewKey = sessionReviewKey("combined", session.sessionId);
  const [sessionLog, setSessionLog] = useState<CombinedQuizQuestion[]>(() =>
    loadSessionReview(
      reviewKey,
      session.startedAt,
      unreviewedSessionQuestions(session.questions, session.reviewedQuestionCount)
    )
  );
  const [sessionReviewActive, setSessionReviewActive] = useState(false);
  const [sessionReviewIndex, setSessionReviewIndex] = useState(0);

  const outbox = useAnswerOutbox();

  // Load BOTH domains' payloads for the whole session up front, soonest cards first, so a
  // connection drop mid-quiz can't leave a card without its definitions or descriptions.
  // Computed once and frozen — see the note in `QuizTaking.tsx`.
  const orderedQuestions = currentSession.questions;
  const [[prefetchWordIds, prefetchGrammarIds]] = useState<[string[], string[]]>(() => {
    const wordIds: string[] = [];
    const grammarIds: string[] = [];
    for (const q of session.questions) {
      if (q.kind === "word") wordIds.push(q.wordId);
      else grammarIds.push(q.grammarId);
    }
    return [wordIds, grammarIds];
  });
  const prefetch = useQuizPrefetch(currentSession.language, prefetchWordIds, prefetchGrammarIds);

  useEffect(() => {
    // The Group B and mixed variants have no flag concept — skip the fetch entirely.
    if (usesGroupBControls) return;
    getFlaggedWordIds(session.language)
      .then(({ wordIds }) => setAlreadyFlaggedIds(new Set(wordIds)))
      .catch(() => setAlreadyFlaggedIds(new Set()));
  }, [session.language, usesGroupBControls]);

  // One groups fetch, three consumers: the names behind the per-group progress badges, the
  // A/B category of each group (which drives the per-category progress and the mixed weights
  // editor), and the category-B membership sets that gate the remove-from-Group-B control.
  // The group docs own membership (`wordIds`/`grammarIds`), so all three fall out of one response.
  useEffect(() => {
    const hasWordGroups =
      session.wordGroupMembership && Object.keys(session.wordGroupMembership).length > 0;
    const hasGrammarGroups =
      session.grammarGroupMembership && Object.keys(session.grammarGroupMembership).length > 0;
    // The mixed quiz has cards of both kinds regardless of which membership maps came back,
    // so the B gate needs both domains whenever the Group B controls are in play.
    const needWords = hasWordGroups || usesGroupBControls;
    const needGrammar = hasGrammarGroups || usesGroupBControls;
    if (!needWords && !needGrammar) return;
    Promise.all([
      needWords ? getGroups(session.language).catch(() => null) : Promise.resolve([]),
      needGrammar ? getGrammarGroups(session.language).catch(() => null) : Promise.resolve([]),
    ]).then(([wordGroups, grammarGroups]) => {
      const allGroups = [...(wordGroups ?? []), ...(grammarGroups ?? [])];
      setGroupNameMap(new Map([[UNGROUPED_A, t("ungroupedA")], ...allGroups.map((g): [string, string] => [g.id, g.name])]));
      setGroupCategoryMap(new Map([[UNGROUPED_A, "A"], ...allGroups.map((g): [string, GroupCategory] => [g.id, categoryOf(g)])]));
      // A failed fetch leaves `groupBIds` null rather than claiming "in no B group".
      if (!wordGroups || !grammarGroups) return;
      setGroupBIds({
        words: new Set(categoryGroups(wordGroups, "B").flatMap((g) => g.wordIds)),
        grammar: new Set(categoryGroups(grammarGroups, "B").flatMap((g) => g.grammarIds)),
      });
      const wordHomes = new Map<string, string>();
      for (const g of categoryGroups(wordGroups, "A"))
        for (const id of g.wordIds) if (!wordHomes.has(id)) wordHomes.set(id, g.id);
      const grammarHomes = new Map<string, string>();
      for (const g of categoryGroups(grammarGroups, "A"))
        for (const id of g.grammarIds) if (!grammarHomes.has(id)) grammarHomes.set(id, g.id);
      setAGroupHome({ words: wordHomes, grammar: grammarHomes });
      setActualAMembership({
        word: Object.fromEntries(categoryGroups(wordGroups, "A").map(g => [g.id, g.wordIds])),
        grammar: Object.fromEntries(categoryGroups(grammarGroups, "A").map(g => [g.id, g.grammarIds])),
      });
    });
  }, [
    session.language,
    session.wordGroupMembership,
    session.grammarGroupMembership,
    usesGroupBControls,
  ]);

  // Mobile: the page scrolls when an answer is tall (min-h-full container), so
  // reset to the top on each new question — otherwise the prompt stays off-screen.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [currentIndex, sessionReviewIndex]);

  // The slim entry wins over the cached payload so a stale cache can never overwrite the
  // session's answer state.
  const slimQuestion = currentIndex < orderedQuestions.length ? orderedQuestions[currentIndex] : null;
  const question: CombinedQuizQuestion | null =
    slimQuestion?.kind === "word"
      ? ({ ...prefetch.words.get(slimQuestion.wordId), ...slimQuestion } as CombinedQuizWordQuestion)
      : slimQuestion ?? null;
  const isComplete = currentSession.status === "completed";
  const wordQuestion = question?.kind === "word" ? question : null;
  const grammarQuestion = question?.kind === "grammar" ? question : null;
  const grammarItem = grammarQuestion ? prefetch.grammar.get(grammarQuestion.grammarId) : null;

  const definitions = wordQuestion?.definitions ?? [];
  const examples = wordQuestion?.examples ?? [];
  const visibleDefinitions = showAllDefinitions ? definitions : definitions.slice(0, VISIBLE_ANSWER_ITEMS);
  const visibleExamples = showAllExamples ? examples : examples.slice(0, VISIBLE_ANSWER_ITEMS);

  // Per-domain progress (Vocabulary vs Grammar): remaining unique items / total unique items.
  const domainProgress = useMemo(() => {
    const stats = {
      word: { remaining: new Set<string>(), total: new Set<string>() },
      grammar: { remaining: new Set<string>(), total: new Set<string>() },
    };
    for (const q of orderedQuestions) {
      const refId = q.kind === "word" ? q.wordId : q.grammarId;
      stats[q.kind].total.add(refId);
      if (q.userCorrect === undefined) stats[q.kind].remaining.add(refId);
    }
    return (["word", "grammar"] as const)
      .map((kind) => ({
        kind,
        label: kind === "word" ? t("sectionVocabulary") : t("sectionGrammar"),
        remaining: stats[kind].remaining.size,
        total: stats[kind].total.size,
      }))
      .filter((d) => d.total > 0);
  }, [orderedQuestions, t]);

  // Per-group progress for word groups and grammar groups combined.
  const groupProgress = useMemo(() => {
    const detailMembership = (kind: QuizDomain): Record<string, string[]> | undefined => {
      if (variant !== "mixed") return kind === "word" ? currentSession.wordGroupMembership : currentSession.grammarGroupMembership;
      const scope = currentSession.mixedScope;
      const b = (kind === "word" ? scope?.wordB : scope?.grammarB) ?? {};
      const a = { ...(kind === "word" ? scope?.wordA : scope?.grammarA), ...actualAMembership[kind] };
      const ids = new Set(orderedQuestions.filter(q => q.kind === kind).map(q => q.kind === "word" ? q.wordId : q.grammarId));
      const grouped = new Set(Object.values(a).flat());
      a[UNGROUPED_A] = [...ids].filter(id => !grouped.has(id));
      return Object.fromEntries(Object.entries({ ...a, ...b }).map(([gid, members]): [string, string[]] => [gid, [...new Set(members)].filter(id => ids.has(id))]).filter(([, members]) => members.length));
    };
    const wordMembership = detailMembership("word");
    const grammarMembership = detailMembership("grammar");
    const unansweredWordIds = new Set(
      orderedQuestions.filter((q) => q.kind === "word" && q.userCorrect === undefined).map((q) => (q as { wordId: string }).wordId)
    );
    const unansweredGrammarIds = new Set(
      orderedQuestions.filter((q) => q.kind === "grammar" && q.userCorrect === undefined).map((q) => (q as { grammarId: string }).grammarId)
    );
    const rows: {
      id: string;
      kind: QuizDomain;
      category?: GroupCategory;
      name: string;
      remaining: number;
      total: number;
    }[] = [];
    for (const [gid, ids] of Object.entries(wordMembership ?? {})) {
      rows.push({
        id: gid,
        kind: "word",
        category: gid === UNGROUPED_A ? "A" : groupCategoryMap.get(gid) ?? (variant === "mixed" ? "A" : undefined),
        name: gid === UNGROUPED_A ? t("ungroupedA") : groupNameMap.get(gid) ?? gid,
        remaining: ids.filter((id) => unansweredWordIds.has(id)).length,
        total: ids.length,
      });
    }
    for (const [gid, ids] of Object.entries(grammarMembership ?? {})) {
      rows.push({
        id: gid,
        kind: "grammar",
        category: gid === UNGROUPED_A ? "A" : groupCategoryMap.get(gid) ?? (variant === "mixed" ? "A" : undefined),
        name: gid === UNGROUPED_A ? t("ungroupedA") : groupNameMap.get(gid) ?? gid,
        remaining: ids.filter((id) => unansweredGrammarIds.has(id)).length,
        total: ids.length,
      });
    }
    return rows.length > 0 ? rows : null;
  }, [
    currentSession,
    actualAMembership,
    variant,
    t,
    orderedQuestions,
    groupNameMap,
    groupCategoryMap,
  ]);

  const progressPanelRows = useMemo(() => {
    if (!groupProgress || !progressSelection) return [];
    return groupProgress.filter(
      (group) =>
        (!progressSelection.category || group.category === progressSelection.category) &&
        (!progressSelection.kind || group.kind === progressSelection.kind)
    );
  }, [groupProgress, progressSelection]);

  function toggleProgressPanel(next: ProgressSelection) {
    setProgressSelection((current) =>
      current?.category === next.category && current?.kind === next.kind ? null : next
    );
  }

  function isProgressSelectionActive(selection: ProgressSelection): boolean {
    return (
      progressSelection?.category === selection.category &&
      progressSelection?.kind === selection.kind
    );
  }

  function hasProgressGroups(selection: ProgressSelection): boolean {
    return (
      groupProgress?.some(
        (group) =>
          (!selection.category || group.category === selection.category) &&
          (!selection.kind || group.kind === selection.kind)
      ) ?? false
    );
  }

  /**
   * Progress per (meta-group, domain) — the four buckets the mixed A+B quiz is actually made
   * of. Rolled up from the same session membership maps `groupProgress` reads, joined to each
   * group's category; `assignMembership` files every item under exactly ONE group, so the
   * buckets partition the pool and a retry duplicate cannot double-count (ids, not questions).
   *
   * `null` unless the session really spans both categories, which keeps the Group A, Group B
   * and article quizzes on their existing two pills. Keyed off the session rather than
   * `variant`, the same self-describing rule as `weightsAdjustable`.
   *
   * A session with an "already-correct" bucket partitions its mastered items into
   * `correctMembership` BEFORE membership is built, so they belong to no group. Those surface
   * as a separate neutral row instead of silently making the four buckets not add up.
   */
  const categoryProgress = useMemo(() => {
    if (variant === "mixed") return mixedCategoryProgress(currentSession).map(row => ({
      ...row, label: t(row.category === "A" ? "categoryALabel" : "categoryBLabel"),
    }));
    if (groupCategoryMap.size === 0) return null;
    const membership = {
      word: currentSession.wordGroupMembership,
      grammar: currentSession.grammarGroupMembership,
    };
    const bucket: Record<GroupCategory, Record<QuizDomain, Set<string>>> = {
      A: { word: new Set(), grammar: new Set() },
      B: { word: new Set(), grammar: new Set() },
    };
    const claimed: Record<QuizDomain, Set<string>> = { word: new Set(), grammar: new Set() };
    for (const kind of QUIZ_DOMAINS) {
      for (const [gid, ids] of Object.entries(membership[kind] ?? {})) {
        const cat = groupCategoryMap.get(gid);
        if (!cat) continue;
        for (const id of ids) {
          bucket[cat][kind].add(id);
          claimed[kind].add(id);
        }
      }
    }
    const present = (cat: GroupCategory) => QUIZ_DOMAINS.some((k) => bucket[cat][k].size > 0);
    if (!present("A") || !present("B")) return null;

    const unanswered: Record<QuizDomain, Set<string>> = { word: new Set(), grammar: new Set() };
    const seen: Record<QuizDomain, Set<string>> = { word: new Set(), grammar: new Set() };
    for (const q of orderedQuestions) {
      const refId = q.kind === "word" ? q.wordId : q.grammarId;
      seen[q.kind].add(refId);
      if (q.userCorrect === undefined) unanswered[q.kind].add(refId);
    }
    const cell = (ids: Set<string>, kind: QuizDomain) => ({
      kind,
      total: ids.size,
      remaining: [...ids].filter((id) => unanswered[kind].has(id)).length,
    });

    const rows = (["A", "B"] as const).map((category) => ({
      category,
      label: category === "A" ? t("categoryALabel") : t("categoryBLabel"),
      cells: QUIZ_DOMAINS.map((k) => cell(bucket[category][k], k)).filter((c) => c.total > 0),
    }));
    const leftover = QUIZ_DOMAINS.map((k) =>
      cell(new Set([...seen[k]].filter((id) => !claimed[k].has(id))), k)
    ).filter((c) => c.total > 0);
    if (leftover.length > 0) {
      rows.push({ category: "other" as never, label: t("progressOther"), cells: leftover });
    }
    return rows;
  }, [
    currentSession,
    variant,
    groupCategoryMap,
    orderedQuestions,
    t,
  ]);

  function resetExpandedAnswers() {
    setShowAllDefinitions(false);
    setShowAllExamples(false);
  }

  // Mixed scope can gain live B items and explicit A continuations while the quiz is open.
  const adjustableGroupIds = useMemo<Record<QuizDomain, Set<string>>>(() => {
    const active = variant === "mixed" ? currentSession : session;
    const questionIds = { word: new Set<string>(), grammar: new Set<string>() };
    for (const q of active.questions) questionIds[q.kind].add(q.kind === "word" ? q.wordId : q.grammarId);
    return {
      word: representedGroupIds(active.wordGroupMembership, questionIds.word),
      grammar: representedGroupIds(active.grammarGroupMembership, questionIds.grammar),
    };
  }, [currentSession, session, variant]);

  function openWeightsPanel() {
    setDomainDraft({
      word: String(currentSession.domainWeights?.word ?? 1),
      grammar: String(currentSession.domainWeights?.grammar ?? 1),
    });
    const mix = currentSession.mixWeights;
    setWordWeightDraft(
      restoreGroupWeightDraft(
        Object.keys(currentSession.wordGroupMembership ?? {}),
        mix?.groups?.word,
        currentSession.wordGroupWeights,
        groupCategoryMap
      )
    );
    setGrammarWeightDraft(
      restoreGroupWeightDraft(
        Object.keys(currentSession.grammarGroupMembership ?? {}),
        mix?.groups?.grammar,
        currentSession.grammarGroupWeights,
        groupCategoryMap
      )
    );
    setCorrectDraft(currentSession.correctWeight !== undefined ? String(currentSession.correctWeight) : "");
    if (mix) {
      setMixCategoryDraft({ A: String(mix.category.A), B: String(mix.category.B) });
      setMixDomainDraft({
        A: { word: String(mix.domain.A.word), grammar: String(mix.domain.A.grammar) },
        B: { word: String(mix.domain.B.word), grammar: String(mix.domain.B.grammar) },
      });
    }
    setWeightsOpen(true);
  }

  /** The session's snapshotted groups, per domain, tagged with their category. The mixed fold
   *  receives the adjustable subset below, excluding snapshots that contributed no questions. */
  const weightGroups: Record<QuizDomain, { id: string; category?: GroupCategory }[]> = {
    word: Object.keys(currentSession.wordGroupMembership ?? {}).map((id) => ({
      id,
      category: currentSession.mixedScope
        ? (Object.hasOwn(currentSession.mixedScope.wordA, id) ? "A" : "B")
        : groupCategoryMap.get(id),
    })),
    grammar: Object.keys(currentSession.grammarGroupMembership ?? {}).map((id) => ({
      id,
      category: currentSession.mixedScope
        ? (Object.hasOwn(currentSession.mixedScope.grammarA, id) ? "A" : "B")
        : groupCategoryMap.get(id),
    })),
  };
  /**
   * The three-level editor needs all three of: a mixed session, the stored ratios to seed from,
   * and the group→category map to fold against. Missing any one (a session started before this
   * existed, or a failed groups fetch) falls back to the flat word/grammar editor, which still
   * works — it just can't retune the A:B balance.
   */
  const mixEditable =
    variant === "mixed" && !!currentSession.mixWeights && (!!currentSession.mixedScope || groupCategoryMap.size > 0);
  const foldedMix = mixEditable
    ? foldMixWeights({
        draft: { category: mixCategoryDraft, domain: mixDomainDraft },
        wordGroups: weightGroups.word,
        selectedWord: adjustableGroupIds.word,
        wordRaw: wordWeightDraft,
        grammarGroups: weightGroups.grammar,
        selectedGrammar: adjustableGroupIds.grammar,
        grammarRaw: grammarWeightDraft,
      })
    : null;

  // In mixed mode the effective domain weights are the FOLD of the six inputs, so both the
  // "is it a number" check and the "is anything positive" check read from there.
  const domainDraftWordNum = foldedMix
    ? parseWeightInput(foldedMix.domain.word)
    : parseWeightInput(domainDraft.word);
  const domainDraftGrammarNum = foldedMix
    ? parseWeightInput(foldedMix.domain.grammar)
    : parseWeightInput(domainDraft.grammar);
  const hasInvalidMixDraft =
    mixEditable &&
    CATEGORY_KEYS.some(
      (cat) =>
        parseWeightInput(mixCategoryDraft[cat]) === null ||
        QUIZ_DOMAINS.some((k) => parseWeightInput(mixDomainDraft[cat][k]) === null)
    );
  const hasInvalidDomainDraft =
    hasInvalidMixDraft || domainDraftWordNum === null || domainDraftGrammarNum === null;
  const hasInvalidWordWeightDraft = [...adjustableGroupIds.word].some(
    (gid) => !isWeightValid(wordWeightDraft[gid], 0)
  );
  const hasInvalidGrammarWeightDraft = [...adjustableGroupIds.grammar].some(
    (gid) => !isWeightValid(grammarWeightDraft[gid], 0)
  );
  // Already-correct: blank = feature off; a number (incl. 0) activates the top-level bucket.
  const correctDraftActive = correctDraft.trim() !== "";
  const correctDraftNum = parseWeightInput(correctDraft);
  const correctDraftInvalid = correctDraftActive && !isWeightValid(correctDraft, 0);
  const correctDomainActive = correctDraftActive && (correctDraftNum ?? 0) > 0;
  const canApplyWeights =
    !hasInvalidDomainDraft &&
    !hasInvalidWordWeightDraft &&
    !hasInvalidGrammarWeightDraft &&
    !correctDraftInvalid &&
    !((domainDraftWordNum ?? 0) <= 0 && (domainDraftGrammarNum ?? 0) <= 0 && !correctDomainActive);

  // Apply new domain/group weights mid-session: the server reorders the
  // unanswered tail and returns the full session; re-sync local order and jump
  // to the first unanswered question of the new order.
  async function applyWeights() {
    if (getOutboxState().pending || getOutboxState().failed) return;
    if (applyingWeights || !canApplyWeights) return;
    setApplyingWeights(true);
    try {
      // Normalize each competing set independently (scale to integers + GCD-reduce): the
      // word/grammar/already-correct domains merge together, each domain's groups compete alone.
      // Mixed folds its three-level form down to these same knobs first, so the normalization
      // below is identical for both modes — only its inputs differ. See `foldMixWeights`.
      const domainRaw: Record<string, string> = foldedMix
        ? { word: foldedMix.domain.word, grammar: foldedMix.domain.grammar }
        : { word: domainDraft.word, grammar: domainDraft.grammar };
      if (correctDraftActive) domainRaw.correct = correctDraft;
      const d = scaleWeightRecord(domainRaw);
      const domainWeights = { word: d.word, grammar: d.grammar };
      const enabledDraft = (draft: Record<string, string>, enabled: Set<string>) =>
        Object.fromEntries(Object.entries(draft).filter(([gid]) => enabled.has(gid)));
      const wordGroupWeights = scaleWeightRecord(
        foldedMix?.wordGroupWeights ?? enabledDraft(wordWeightDraft, adjustableGroupIds.word)
      );
      const grammarGroupWeights = scaleWeightRecord(
        foldedMix?.grammarGroupWeights ?? enabledDraft(grammarWeightDraft, adjustableGroupIds.grammar)
      );
      // Sent alongside the folded weights so a later reopen shows the ratios back, not the fold.
      const mixWeights: MixWeightConfig | null = mixEditable
        ? {
            category: {
              A: parseWeightInput(mixCategoryDraft.A) ?? 0,
              B: parseWeightInput(mixCategoryDraft.B) ?? 0,
            },
            domain: {
              A: {
                word: parseWeightInput(mixDomainDraft.A.word) ?? 0,
                grammar: parseWeightInput(mixDomainDraft.A.grammar) ?? 0,
              },
              B: {
                word: parseWeightInput(mixDomainDraft.B.word) ?? 0,
                grammar: parseWeightInput(mixDomainDraft.B.grammar) ?? 0,
              },
            },
            groups: {
              word: serializeGroupWeightDraft(
                weightGroups.word.map((g) => g.id),
                wordWeightDraft
              ),
              grammar: serializeGroupWeightDraft(
                weightGroups.grammar.map((g) => g.id),
                grammarWeightDraft
              ),
            },
          }
        : null;
      const updated = await updateCombinedQuizWeights(currentSession.language, {
        domainWeights,
        ...(mixWeights ? { mixWeights } : {}),
        ...(correctDraftActive ? { correctWeight: d.correct } : {}),
        ...(Object.keys(wordGroupWeights).length > 0 ? { wordGroupWeights } : {}),
        ...(Object.keys(grammarGroupWeights).length > 0 ? { grammarGroupWeights } : {}),
      }, variant);
      setCurrentSession(updated);
      const firstUnanswered = updated.questions.findIndex((q) => q.userCorrect === undefined);
      // The new order can land the cursor back on an index already graded this session; the
      // double-tap guard keys off the index, so it must be cleared or that card is unanswerable.
      gradedIndexRef.current = -1;
      setCurrentIndex(firstUnanswered === -1 ? updated.questions.length : firstUnanswered);
      setShowingAnswer(false);
      resetExpandedAnswers();
      setFlaggedIds(new Set());
      setWeightsOpen(false);
    } catch {
      // Keep the panel open so the user can retry.
    } finally {
      setApplyingWeights(false);
    }
  }

  function revealAnswer() {
    if (!question) return;
    resetExpandedAnswers();
    setShowingAnswer(true);
    setFlaggedIds(question.kind === "word" ? new Set([question.wordId]) : new Set());
  }

  const segmentWords = useMemo(() => {
    if (!wordQuestion?.examples) return [];
    const seen = new Set<string>();
    const result: { id: string; text: string; transliteration?: string }[] = [];
    for (const ex of wordQuestion.examples) {
      for (const seg of ex.segments ?? []) {
        if (seg.id && seg.id !== wordQuestion.wordId && !alreadyFlaggedIds.has(seg.id) && !seen.has(seg.id)) {
          seen.add(seg.id);
          result.push({ id: seg.id, text: seg.text, transliteration: seg.transliteration });
        }
      }
    }
    return result;
  }, [alreadyFlaggedIds, wordQuestion]);

  function toggleFlag(id: string) {
    setFlaggedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Unknown membership (`groupBIds === null`) counts as "in B" so the control never
   *  vanishes from the Group B quiz because a groups request was slow or failed. */
  function isInGroupB(refId: string, kind: "word" | "grammar") {
    if (variant === "mixed" && currentSession.mixedScope) {
      const b = kind === "word" ? currentSession.mixedScope.wordB : currentSession.mixedScope.grammarB;
      if (b) return Object.values(b).some(ids => ids.includes(refId));
    }
    if (!groupBIds) return true;
    return kind === "word" ? groupBIds.words.has(refId) : groupBIds.grammar.has(refId);
  }

  /** The MARK half of the two-step removal: press marks, press again unmarks. The DELETE
   *  itself only fires when the user moves past the card — `handleGrade` / `endSession`. */
  function togglePendingRemoveFromB(refId: string, kind: "word" | "grammar") {
    const key = bKey(kind, refId);
    if (removedFromBIds.has(key)) return; // already gone / commit in flight
    setPendingRemoveBIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Group B: the keyboard mark as a clickable control. Removed cards have no receipt.
  function GroupBExcludeControl({ refId, kind }: { refId: string; kind: "word" | "grammar" }) {
    if (!usesGroupBControls) return null;
    const key = bKey(kind, refId);
    if (removedFromBIds.has(key) || !isInGroupB(refId, kind)) return null;
    const pending = pendingRemoveBIds.has(key);
    return (
      <div className="w-full max-w-lg space-y-1">
        <button
          type="button"
          aria-pressed={pending}
          onClick={() => togglePendingRemoveFromB(refId, kind)}
          className={
            pending
              ? "w-full rounded-md border border-amber-500 bg-amber-950/60 px-3 py-2.5 text-center text-sm font-medium text-amber-200 hover:bg-amber-950/80 disabled:opacity-50 sm:py-1.5 sm:text-left sm:text-xs"
              : "w-full rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2.5 text-center text-sm font-medium text-amber-300 hover:bg-amber-950/60 disabled:opacity-50 sm:bg-transparent sm:py-1.5 sm:text-left sm:text-xs sm:font-normal sm:hover:bg-amber-950/30"
          }
        >
          {/* The "3" hint only means something where there is a keyboard. */}
          <span className="hidden sm:inline">3 · </span>
          {pending ? `⏳ ${t("removeFromGroupBPending")}` : t("removeFromGroupB")}
        </button>
      </div>
    );
  }

  /** Local-first — see `utils/quizLocal.ts`. The write is queued, never awaited. */
  function handleGrade(correct: boolean) {
    if (!question || applyingWeights || gradedIndexRef.current === currentIndex) return;
    gradedIndexRef.current = currentIndex;
    const refId = question.kind === "word" ? question.wordId : question.grammarId;
    const removeFromGroupB = pendingRemoveBIds.has(bKey(question.kind, refId));
    const submittedFlagIds = !usesGroupBControls && question.kind === "word" ? Array.from(flaggedIds) : [];

    outbox.enqueue({
      domain: "combined",
      language: currentSession.language,
      variant,
      kind: question.kind,
      refId,
      correct,
      ...(variant === "mixed" ? { removeFromGroupB, startedAt: session.startedAt, operationId: crypto.randomUUID() } : {}),
      ...(submittedFlagIds.length > 0 ? { flagWordIds: submittedFlagIds } : {}),
    });

    if (submittedFlagIds.length > 0) {
      setAlreadyFlaggedIds((prev) => new Set([...prev, ...submittedFlagIds]));
    }

    // Grading is "moving on" — commit a deferred Group B removal marked on this card.
    const gradedKey = bKey(question.kind, refId);
    if (pendingRemoveBIds.has(gradedKey)) {
      setPendingRemoveBIds((prev) => {
        const next = new Set(prev);
        next.delete(gradedKey);
        return next;
      });
      if (variant === "mixed") setRemovedFromBIds(prev => new Set([...prev, gradedKey]));
    }

    setCurrentSession(prev => variant === "mixed"
      ? applyMixedOperation(prev, { kind: question.kind, refId, correct, removeFromGroupB },
          (question.kind === "word" ? aGroupHome?.words : aGroupHome?.grammar)?.get(refId))
      : applyCombinedAnswerLocally(prev, question.kind, refId, correct));
    const reviewQuestion = { ...orderedQuestions[currentIndex], userCorrect: correct };
    setSessionLog((prev) =>
      appendSessionReview(reviewKey, session.startedAt, prev, reviewQuestion)
    );
    setCurrentIndex((i) => i + 1);
    setShowingAnswer(false);
    resetExpandedAnswers();
    setFlaggedIds(new Set());
  }

  function endSession() {
    if (sessionLog.length === 0) return;
    // 🏁 is also "moving on": commit a pending Group B removal on the current card.
    if (question) {
      const refId = question.kind === "word" ? question.wordId : question.grammarId;
      const key = bKey(question.kind, refId);
      if (pendingRemoveBIds.has(key)) {
        setPendingRemoveBIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        if (variant === "mixed") {
          outbox.enqueue({ domain: "combinedRemoval", language: session.language, kind: question.kind,
            refId, startedAt: session.startedAt, operationId: crypto.randomUUID() });
          setRemovedFromBIds(prev => new Set([...prev, key]));
          setCurrentSession(prev => applyMixedOperation(prev, { kind: question.kind, refId, removeFromGroupB: true },
            (question.kind === "word" ? aGroupHome?.words : aGroupHome?.grammar)?.get(refId)));
        }
      }
    }
    setSessionReviewIndex(0);
    setSessionReviewActive(true);
  }

  function returnToQuiz() {
    setSessionLog([]);
    setSessionReviewActive(false);
    setSessionReviewIndex(0);
    const index = currentSession.questions.findIndex(q => q.userCorrect === undefined);
    setCurrentIndex(index < 0 ? currentSession.questions.length : index);
    gradedIndexRef.current = -1;
    setShowingAnswer(false);
  }

  function nextSessionReview() {
    const next = sessionReviewIndex + 1;
    if (next >= sessionLog.length) {
      completeSessionReview(reviewKey, session.startedAt);
      setCurrentSession(prev => variant === "mixed"
        ? orderMixedQuestions(finishQuizSitting(prev)) : finishQuizSitting(prev));
      outbox.enqueue({
        domain: "combinedReviewComplete",
        language: currentSession.language,
        startedAt: session.startedAt,
        variant,
      });
    }
    setSessionReviewIndex(next);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Ignore shortcuts while typing in a form control (e.g. the weights panel).
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      // Session review: no grading, "Next" only — advance on "1" or "2".
      if (sessionReviewActive) {
        if (event.repeat) return;
        if (event.key === "1" || event.key === "2") {
          event.preventDefault();
          nextSessionReview();
        }
        return;
      }

      if (!showingAnswer) {
        if (question && !event.repeat && (event.key === " " || event.code === "Space")) {
          event.preventDefault();
          revealAnswer();
        }
        return;
      }

      if (event.repeat) return;
      if (event.key === "1") {
        event.preventDefault();
        void handleGrade(false);
      } else if (event.key === "2") {
        event.preventDefault();
        void handleGrade(true);
      } else if (event.key === "3" && usesGroupBControls && question) {
        // Group B: "3" MARKS the item to be retired from every Group B group it belongs to
        // (both domains) once the user moves on — grade or 🏁; a second press unmarks. The
        // item stays in the current session either way.
        event.preventDefault();
        const refId = question.kind === "word" ? question.wordId : question.grammarId;
        // Same gate as the on-screen control: the mixed quiz's A-only cards are not in B,
        // and the key must not do what the button declines to offer.
        if (!isInGroupB(refId, question.kind)) return;
        togglePendingRemoveFromB(refId, question.kind);
      } else if (event.key === "3" && !usesGroupBControls && question?.kind === "word") {
        event.preventDefault();
        const wordId = question.wordId;
        if (alreadyFlaggedIds.has(wordId)) {
          unflagWord(currentSession.language, wordId).catch(() => {});
          setAlreadyFlaggedIds((prev) => { const next = new Set(prev); next.delete(wordId); return next; });
          setFlaggedIds((prev) => { const next = new Set(prev); next.delete(wordId); return next; });
        } else {
          flagWord(currentSession.language, wordId).catch(() => {});
          setAlreadyFlaggedIds((prev) => new Set([...prev, wordId]));
          setFlaggedIds((prev) => new Set([...prev, wordId]));
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [question, showingAnswer, handleGrade, alreadyFlaggedIds, currentSession.language, sessionReviewActive, usesGroupBControls, groupBIds, pendingRemoveBIds, removedFromBIds]);


  if (sessionReviewActive) {
    const reviewSlim = sessionReviewIndex < sessionLog.length ? sessionLog[sessionReviewIndex] : null;
    const reviewQ: CombinedQuizQuestion | null = reviewSlim?.kind === "word"
      ? { ...prefetch.words.get(reviewSlim.wordId), ...reviewSlim }
      : reviewSlim;
    if (!reviewQ) {
      const sessionCorrect = sessionLog.filter((q) => q.userCorrect).length;
      return (
        <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
          <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("sessionReviewComplete")}</h2>
          <p className="text-2xl sm:text-4xl font-semibold text-indigo-400">
            {sessionCorrect} / {sessionLog.length}
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={() => { onComplete(); onBrowse(); }}
              className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700"
            >
              {t("browseWords")}
            </button>
            <button
              onClick={isComplete ? () => { onComplete(); onStartNew(); } : returnToQuiz}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-500"
            >
              {t(isComplete ? "startNew" : "returnToQuiz")}
            </button>
          </div>
        </div>
      );
    }

    const reviewRefId = reviewQ.kind === "word" ? reviewQ.wordId : reviewQ.grammarId;
    const reviewCache = reviewQ.kind === "word" ? prefetch.words : prefetch.grammar;
    if (!reviewCache.has(reviewRefId) && !prefetch.missing.has(reviewRefId)) {
      return (
        <QuizLoadState
          error={prefetch.error}
          loaded={prefetch.loaded}
          total={prefetch.total}
          onRetry={prefetch.retry}
        />
      );
    }

    const reviewWord = reviewQ.kind === "word" ? reviewQ : null;
    const reviewGrammar = reviewQ.kind === "grammar" ? reviewQ : null;
    const reviewGrammarItem = reviewGrammar ? prefetch.grammar.get(reviewGrammar.grammarId) : null;
    const reviewDefs = reviewWord?.definitions ?? [];
    const reviewExamples = reviewWord?.examples ?? [];

    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        <p className="text-sm text-gray-400">{sessionReviewIndex + 1} / {sessionLog.length}</p>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium border ${
            reviewQ.kind === "word"
              ? "bg-blue-900/40 text-blue-300 border-blue-700/50"
              : "bg-emerald-900/40 text-emerald-300 border-emerald-700/50"
          }`}
        >
          {reviewQ.kind === "word" ? t("sectionVocabulary") : t("sectionGrammar")}
        </span>
        {reviewWord ? (
          <h2 className="max-w-full break-words px-2 text-center text-xl sm:text-3xl font-bold text-gray-100">{reviewWord.term}</h2>
        ) : (
          <h2 className="max-w-full break-words px-2 text-center text-xl sm:max-w-lg sm:text-3xl font-bold text-gray-100">
            {reviewGrammar!.statement || reviewGrammarItem?.statement}
          </h2>
        )}

        {reviewWord && settings.showKoreanHanja && reviewWord.hanjaReadings && reviewWord.hanjaReadings.length > 0 && (
          <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="h-px flex-1 bg-amber-500/50"></div>
              <span className="text-xs font-semibold text-amber-400">🀄 {t("sectionKoreanHanja")}</span>
              <div className="h-px flex-1 bg-amber-500/50"></div>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              {reviewWord.hanjaReadings.map((r, i) => (
                <div key={i} className="flex flex-col items-center rounded-lg bg-gray-800 px-3 py-2 text-center min-w-[56px]">
                  <div className="flex items-baseline gap-1 text-base font-medium text-gray-100">
                    <span>{r.simplifiedChar}</span>
                    {r.simplifiedChar !== r.traditionalChar && (
                      <>
                        <span className="text-xs text-gray-500">→</span>
                        <span className="text-amber-300">{r.traditionalChar}</span>
                      </>
                    )}
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {r.hunEum.map((h, j) => (<p key={j} className="text-xs text-gray-400">{h}</p>))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {reviewWord && (
          <div className="text-center space-y-2">
            {reviewDefs.map((m, mi) => (
              <div key={mi}>
                {m.partOfSpeech && <p className="text-xs text-gray-500 italic">{m.partOfSpeech}</p>}
                {(() => {
                  const py = m.pinyins && m.pinyins.length > 0
                    ? m.pinyins.join(" / ")
                    : (mi === 0 ? reviewWord.transliteration : undefined);
                  return py ? <p className="text-sm text-gray-400">{py}</p> : null;
                })()}
                {displayDefEntries(m.text || {}).map(([lang, text]) => (
                  <p key={lang} className="text-xl text-green-400">
                    <span className="text-sm text-gray-400">{LANG_LABEL_MAP[lang] || lang}: </span>{text}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}

        {reviewGrammarItem && <GrammarDescriptionsPanel item={reviewGrammarItem} />}

        {reviewWord && reviewExamples.length > 0 && (
          <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
            <ExamplesHeader
              showPinyin={showExamplePinyin}
              onToggle={hasExampleReadings(reviewExamples) ? toggleExamplePinyin : undefined}
            />
            {reviewExamples.map((ex, i) => (
              <div key={i} className="mb-2 last:mb-0">
                <p className="text-lg text-gray-100">
                  <RubyText text={ex.sentence} segments={showExamplePinyin ? ex.segments : undefined} />
                </p>
                <TranslationDisplay translation={ex.translation} />
              </div>
            ))}
          </div>
        )}

        {reviewGrammarItem && reviewGrammarItem.examples && reviewGrammarItem.examples.length > 0 && (
          <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
            <ExamplesHeader
              showPinyin={showExamplePinyin}
              onToggle={
                hasExampleReadings(reviewGrammarItem.examples) ? toggleExamplePinyin : undefined
              }
            />
            {reviewGrammarItem.examples.map((ex, i) => (
              <div key={i} className="mb-2 last:mb-0">
                <p className="text-lg text-gray-100">
                  <RubyText text={ex.sentence} segments={showExamplePinyin ? ex.segments : undefined} />
                </p>
                {showExamplePinyin && ex.transliteration && (
                  <p className="text-sm text-gray-500">{ex.transliteration}</p>
                )}
                {typeof ex.translation === "string" ? (
                  ex.translation && <p className="text-sm text-gray-400">{ex.translation}</p>
                ) : (
                  displayGrammarDefEntries(ex.translation).map(([lang, text]) => (
                    <p key={lang} className="text-sm text-gray-400">
                      <span className="mr-1 text-xs font-medium uppercase text-gray-500">{lang}</span>{text}
                    </p>
                  ))
                )}
              </div>
            ))}
          </div>
        )}

        <div className="sticky bottom-0 z-10 -mx-4 flex w-[calc(100%+2rem)] flex-col gap-3 bg-gray-900/95 px-4 py-2 sm:static sm:mx-0 sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:px-0 sm:py-0">
          <button
            onClick={nextSessionReview}
            className="w-full sm:w-auto rounded-lg bg-indigo-600 px-6 py-3 sm:py-2 text-white hover:bg-indigo-500"
          >
            {t("next")}
          </button>
        </div>
      </div>
    );
  }

  if (isComplete || (!question && currentIndex >= orderedQuestions.length)) {
    const { correct } = currentSession.score;
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        {/* The likeliest moment to close the tab — surface any answers still in flight. */}
        <QuizSyncBadge
          prefetch={prefetch}
          pending={outbox.pending}
          failed={outbox.failed}
          onFlush={outbox.flush}
          onAcknowledgeFailed={outbox.acknowledgeFailed}
        />
        <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("quizComplete")}</h2>
        <p className="text-2xl sm:text-4xl font-semibold text-indigo-400">
          {correct} / {currentSession.score.total}
        </p>
        {sessionLog.length > 0 ? (
          <button
            onClick={endSession}
            className="rounded-lg border border-amber-600/70 bg-amber-700/30 px-6 py-2 font-medium text-amber-200 hover:bg-amber-700/50"
          >
            🏁 {t("startSessionReview")}
          </button>
        ) : (
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={() => { onComplete(); onBrowse(); }}
              className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700"
            >
              {t("browseWords")}
            </button>
            <button
              onClick={() => { onComplete(); onStartNew(); }}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-500"
            >
              {t("startNew")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Gate on THIS card's payload, whichever domain it belongs to — see the note in
  // `QuizTaking.tsx`.
  const cardRefId = question ? (question.kind === "word" ? question.wordId : question.grammarId) : "";
  const cardCache = question?.kind === "grammar" ? prefetch.grammar : prefetch.words;
  const cardResolved =
    !!question && (cardCache.has(cardRefId) || prefetch.missing.has(cardRefId));
  if (!cardResolved) {
    return (
      <QuizLoadState
        error={prefetch.error}
        loaded={prefetch.loaded}
        total={prefetch.total}
        onRetry={prefetch.retry}
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 pb-44 lg:p-8">
      <QuizSyncBadge
        prefetch={prefetch}
        pending={outbox.pending}
        failed={outbox.failed}
        onFlush={outbox.flush}
        onAcknowledgeFailed={outbox.acknowledgeFailed}
      />
      <div className="sticky top-0 z-10 -mx-4 flex w-[calc(100%+2rem)] items-center justify-center gap-3 bg-gray-900/95 px-4 py-2 sm:static sm:mx-0 sm:w-auto sm:bg-transparent sm:px-0 sm:py-0">
        <p className="text-sm text-gray-400">
          {currentSession.score.correct} / {originalTotal}
        </p>
        <button
          onClick={endSession}
          title={t("endSession")}
          className="rounded-full border border-amber-600/70 bg-amber-700/30 px-4 py-1.5 text-sm font-medium text-amber-200 hover:bg-amber-700/50 whitespace-nowrap"
        >
          🏁 {t("endSession")}
        </button>
      </div>

      {/* Per-category progress (Group A / Group B × word / grammar), for a session that spans
          both meta-groups. It REPLACES the two domain pills rather than joining them: the four
          buckets already carry the domain split, and six pills is more than a phone can show
          in one glance. */}
      {categoryProgress && (
        <div className="flex w-full max-w-lg flex-col items-center gap-1">
          {variant === "mixed" && <p className="text-center text-xs text-gray-400">{t("mixedProgressHint")}</p>}
          {categoryProgress.map((row) => (
            <div key={row.category} className="flex flex-wrap items-center justify-center gap-2">
              {row.category === "A" || row.category === "B" ? (
                <button
                  type="button"
                  onClick={() => toggleProgressPanel({ category: row.category })}
                  aria-expanded={isProgressSelectionActive({ category: row.category })}
                  className={`rounded border px-2 py-1 text-xs font-semibold transition-colors ${
                  row.category === "B"
                    ? isProgressSelectionActive({ category: row.category })
                      ? "border-amber-400 bg-amber-700/70 text-amber-100"
                      : "border-amber-700/60 bg-amber-900/60 text-amber-300 hover:bg-amber-800/70"
                    : isProgressSelectionActive({ category: row.category })
                      ? "border-indigo-400 bg-indigo-700/70 text-indigo-100"
                      : "border-indigo-700/60 bg-indigo-900/60 text-indigo-300 hover:bg-indigo-800/70"
                }`}
                >
                  {row.label}
                </button>
              ) : (
                <span className="rounded bg-gray-700 px-1.5 py-0.5 text-xs font-semibold text-gray-300">
                  {row.label}
                </span>
              )}
              {row.cells.map((c) => (
                <button
                  type="button"
                  key={c.kind}
                  onClick={() => toggleProgressPanel({ category: row.category, kind: c.kind })}
                  aria-expanded={isProgressSelectionActive({ category: row.category, kind: c.kind })}
                  disabled={!hasProgressGroups({ category: row.category, kind: c.kind })}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                    c.remaining === 0
                      ? "border-green-700/50 bg-green-900/40 text-green-400"
                      : DOMAIN_TONE[c.kind].pill
                  } ${
                    isProgressSelectionActive({ category: row.category, kind: c.kind })
                      ? "ring-2 ring-white/60"
                      : "enabled:hover:brightness-125"
                  }`}
                >
                  {c.kind === "word" ? t("sectionVocabulary") : t("sectionGrammar")}: {c.remaining}/
                  {c.total}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Per-domain progress (Vocabulary vs Grammar) */}
      {domainProgress.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2 items-center">
          {!categoryProgress &&
            domainProgress.map((d) => (
              <button
                type="button"
                key={d.kind}
                onClick={() => toggleProgressPanel({ kind: d.kind })}
                aria-expanded={isProgressSelectionActive({ kind: d.kind })}
                disabled={!hasProgressGroups({ kind: d.kind })}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${DOMAIN_TONE[d.kind].pill} ${
                  isProgressSelectionActive({ kind: d.kind })
                    ? "ring-2 ring-white/60"
                    : "enabled:hover:brightness-125"
                }`}
              >
                {d.label}: {d.remaining}/{d.total}
              </button>
            ))}
          {/* A random-order session has no weights to adjust — the server rejects the PUT
              too. Keyed off the session rather than `variant` so it is self-describing. */}
          {weightsAdjustable && (
            <button
              onClick={() => (weightsOpen ? setWeightsOpen(false) : openWeightsPanel())}
              className="rounded-full border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 sm:py-1"
            >
              ⚖ {t("adjustWeights")}
            </button>
          )}
        </div>
      )}

      {/* Mid-session weight editor. Two shapes over one set of controls: the mixed A+B quiz
          gets category → domain → groups (matching its setup modal), everything else keeps the
          flat domain → groups form. Capped and scrollable because it renders inline in the
          document flow — four collapsible group lists would otherwise push the sticky grade
          buttons well past the fold on a phone. */}
      {weightsOpen && weightsAdjustable && (
        <div className="max-h-[65vh] w-full max-w-lg space-y-2 overflow-y-auto rounded-lg border border-gray-600 bg-gray-800 p-4 sm:max-h-none sm:overflow-visible">
          <p className="text-sm font-medium text-gray-300">{t("adjustWeights")}</p>

          {mixEditable
            ? CATEGORY_KEYS.map((cat) => (
                <details
                  key={cat}
                  open
                  className={`rounded border bg-gray-900/30 ${
                    cat === "B" ? "border-amber-900/50" : "border-indigo-900/50"
                  }`}
                >
                  <summary className="flex cursor-pointer select-none items-center gap-2 p-2 text-sm">
                    <span
                      className={`min-w-0 flex-1 truncate font-medium ${
                        cat === "B" ? "text-amber-300" : "text-indigo-300"
                      }`}
                    >
                      {t(cat === "B" ? "categoryBLabel" : "categoryALabel")}
                    </span>
                    <input
                      type="number"
                      min={0}
                      value={mixCategoryDraft[cat]}
                      title={t("categoryWeightHint")}
                      aria-label={`${t(cat === "B" ? "categoryBLabel" : "categoryALabel")} ${t("groupWeight")}`}
                      // Keeps the click off the <summary> (which would fold the category) while
                      // leaving the input's own default behaviour — including its spinner
                      // arrows — intact, which preventDefault would not.
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setMixCategoryDraft((prev) => ({ ...prev, [cat]: e.target.value }))
                      }
                      className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none sm:w-16 sm:py-1 sm:text-xs ${
                        parseWeightInput(mixCategoryDraft[cat]) === null
                          ? "border-red-500 focus:border-red-400"
                          : "border-gray-600 focus:border-indigo-400"
                      }`}
                    />
                  </summary>
                  <div className="space-y-1 px-2 pb-2">
                    {QUIZ_DOMAINS.map((k) => {
                      const groupIds = weightGroups[k]
                        .filter((g) => (g.category ?? "A") === cat)
                        .map((g) => g.id);
                      const draft = k === "word" ? wordWeightDraft : grammarWeightDraft;
                      const setDraft = k === "word" ? setWordWeightDraft : setGrammarWeightDraft;
                      return (
                        <div key={k} className="rounded border border-gray-700/60 p-2">
                          <label className="flex items-center gap-2 text-sm">
                            <span className={`min-w-0 flex-1 truncate font-medium ${DOMAIN_TONE[k].text}`}>
                              {k === "word" ? t("sectionVocabulary") : t("sectionGrammar")}
                            </span>
                            <input
                              type="number"
                              min={0}
                              value={mixDomainDraft[cat][k]}
                              title={t("categoryDomainWeightHint")}
                              aria-label={t("groupWeight")}
                              onChange={(e) =>
                                setMixDomainDraft((prev) => ({
                                  ...prev,
                                  [cat]: { ...prev[cat], [k]: e.target.value },
                                }))
                              }
                              className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none sm:w-16 sm:py-1 sm:text-xs ${
                                parseWeightInput(mixDomainDraft[cat][k]) === null
                                  ? "border-red-500 focus:border-red-400"
                                  : `border-gray-600 ${DOMAIN_TONE[k].focus}`
                              }`}
                            />
                          </label>
                          {cat === "B" ? <p className="mt-1 text-xs text-gray-500">{t("liveGroupBScope")}</p> : groupIds.length > 0 && (
                            <details open={wideViewport} className="mt-1">
                              <summary
                                className={`cursor-pointer select-none text-xs font-semibold ${DOMAIN_TONE[k].text}`}
                              >
                                {t(k === "word" ? "groups" : "grammarGroups")} ({groupIds.length})
                              </summary>
                              <div className="mt-1 space-y-1">
                                {groupIds.map((gid) => (
                                  <label
                                    key={`${k}-${gid}`}
                                    className="flex items-center gap-2 text-sm text-gray-300"
                                  >
                                    <span className="min-w-0 flex-1 truncate pl-4">
                                      {groupNameMap.get(gid) ?? gid}
                                    </span>
                                    <input
                                      type="number"
                                      min={0}
                                      value={draft[gid] ?? "1"}
                                      disabled={!adjustableGroupIds[k].has(gid)}
                                      title={t("groupWeightHint")}
                                      aria-label={t("groupWeight")}
                                      onChange={(e) =>
                                        setDraft((prev) => ({ ...prev, [gid]: e.target.value }))
                                      }
                                      className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500 disabled:opacity-60 sm:w-16 sm:py-1 sm:text-xs ${
                                        !isWeightValid(draft[gid], 0)
                                          ? "border-red-500 focus:border-red-400"
                                          : `border-gray-600 ${DOMAIN_TONE[k].focus}`
                                      }`}
                                    />
                                  </label>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </details>
              ))
            : QUIZ_DOMAINS.map((k) => {
                const groupIds = variant === "mixed" ? [] : weightGroups[k].map((g) => g.id);
                const draft = k === "word" ? wordWeightDraft : grammarWeightDraft;
                const setDraft = k === "word" ? setWordWeightDraft : setGrammarWeightDraft;
                return (
                  /* Each domain's own weight, directly followed by its own groups. */
                  <div
                    key={k}
                    className={`rounded border bg-gray-900/30 p-2 space-y-1 ${
                      k === "word" ? "border-blue-900/50" : "border-emerald-900/50"
                    }`}
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <span className={`min-w-0 flex-1 truncate font-medium ${DOMAIN_TONE[k].text}`}>
                        {k === "word" ? t("sectionVocabulary") : t("sectionGrammar")}
                      </span>
                      <input
                        type="number"
                        min={0}
                        value={domainDraft[k]}
                        title={t("groupWeightHint")}
                        aria-label={t("groupWeight")}
                        onChange={(e) => setDomainDraft((prev) => ({ ...prev, [k]: e.target.value }))}
                        className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none sm:w-16 sm:py-1 sm:text-xs ${
                          parseWeightInput(domainDraft[k]) === null
                            ? "border-red-500 focus:border-red-400"
                            : `border-gray-600 ${DOMAIN_TONE[k].focus}`
                        }`}
                      />
                    </label>
                    {groupIds.length > 0 && (
                      <details open={wideViewport}>
                        <summary
                          className={`cursor-pointer select-none text-xs font-semibold ${DOMAIN_TONE[k].text}`}
                        >
                          {t(k === "word" ? "groups" : "grammarGroups")} ({groupIds.length})
                        </summary>
                        <div className="mt-1 space-y-1">
                          {groupIds.map((gid) => (
                            <label
                              key={`${k}-${gid}`}
                              className="flex items-center gap-2 text-sm text-gray-300"
                            >
                              <span className="min-w-0 flex-1 truncate pl-4">
                                {groupNameMap.get(gid) ?? gid}
                              </span>
                              <input
                                type="number"
                                min={0}
                                value={draft[gid] ?? "1"}
                                disabled={!adjustableGroupIds[k].has(gid)}
                                title={t("groupWeightHint")}
                                aria-label={t("groupWeight")}
                                onChange={(e) =>
                                  setDraft((prev) => ({ ...prev, [gid]: e.target.value }))
                                }
                                className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500 disabled:opacity-60 sm:w-16 sm:py-1 sm:text-xs ${
                                  !isWeightValid(draft[gid], 0)
                                    ? "border-red-500 focus:border-red-400"
                                    : `border-gray-600 ${DOMAIN_TONE[k].focus}`
                                }`}
                              />
                            </label>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}

          {/* Already-correct: top-level bucket peer to the word/grammar domains. */}
          <label
            className="flex items-center gap-2 rounded border border-indigo-900/50 bg-gray-900/30 p-2 text-sm"
            title={t("alreadyCorrectHint")}
          >
            <span className="flex-1 min-w-0 truncate font-medium text-indigo-300">✅ {t("alreadyCorrect")}</span>
            <input
              type="number"
              min={0}
              placeholder="—"
              value={correctDraft}
              aria-label={t("alreadyCorrect")}
              onChange={(e) => setCorrectDraft(e.target.value)}
              className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none sm:w-16 sm:py-1 sm:text-xs ${
                correctDraftInvalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-indigo-400"
              }`}
            />
          </label>

          {!canApplyWeights && (
            <p className="text-xs text-red-400">{t("groupWeightRequiredHint")}</p>
          )}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <button
              onClick={() => setWeightsOpen(false)}
              className="rounded-lg border border-gray-600 px-3 py-2.5 text-sm text-gray-300 hover:bg-gray-700 sm:py-1.5 sm:text-xs"
            >
              {t("cancel")}
            </button>
            <button
              onClick={applyWeights}
              disabled={applyingWeights || !canApplyWeights || outbox.pending > 0 || outbox.failed > 0}
              className="rounded-lg bg-indigo-600 px-3 py-2.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50 sm:py-1.5 sm:text-xs"
            >
              {applyingWeights ? "..." : t("applyWeights")}
            </button>
          </div>
        </div>
      )}

      {/* The aggregate A/B and Vocabulary/Grammar pills above open this focused drill-down.
          Rows use completed/total (plus a bar) while the compact pills retain remaining/total. */}
      {progressSelection && progressPanelRows.length > 0 && (
        <section className="w-full max-w-lg rounded-xl border border-gray-700 bg-gray-800/90 p-4 shadow-lg">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="min-w-0 flex-1 text-sm font-semibold text-gray-100">
              {progressSelection.category && (
                <span
                  className={
                    progressSelection.category === "B" ? "text-amber-300" : "text-indigo-300"
                  }
                >
                  {t(progressSelection.category === "B" ? "categoryBLabel" : "categoryALabel")} ·{" "}
                </span>
              )}
              {progressSelection.kind
                ? t(progressSelection.kind === "word" ? "wordGroupsToggle" : "grammarGroupsToggle")
                : t("groupProgressTitle")}
            </h3>
            <button
              type="button"
              onClick={() => setProgressSelection(null)}
              aria-label={t("closeProgress")}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-lg text-gray-400 hover:bg-gray-700 hover:text-gray-100"
            >
              ×
            </button>
          </div>
          <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {progressPanelRows.map((group) => {
              const completed = group.total - group.remaining;
              const percent = group.total === 0 ? 0 : Math.round((completed / group.total) * 100);
              return (
                <div key={`${group.kind}-${group.id}`}>
                  <div className="mb-1 flex items-baseline gap-3 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium text-gray-200">
                      {group.name}
                    </span>
                    <span className={completed === group.total ? "text-green-400" : "text-gray-400"}>
                      {completed}/{group.total} {t("completedProgress")} · {percent}%
                    </span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-gray-700"
                    role="progressbar"
                    aria-label={group.name}
                    aria-valuemin={0}
                    aria-valuemax={group.total}
                    aria-valuenow={completed}
                  >
                    <div
                      className={`h-full rounded-full transition-[width] ${
                        completed === group.total
                          ? "bg-green-500"
                          : group.kind === "word"
                            ? "bg-blue-500"
                            : "bg-emerald-500"
                      }`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Question type badge */}
      <span
        className={`rounded-full px-3 py-1 text-xs font-medium border ${
          question!.kind === "word"
            ? "bg-blue-900/40 text-blue-300 border-blue-700/50"
            : "bg-emerald-900/40 text-emerald-300 border-emerald-700/50"
        }`}
      >
        {question!.kind === "word" ? t("sectionVocabulary") : t("sectionGrammar")}
      </span>

      {wordQuestion ? (
        <h2 className="max-w-full break-words px-2 text-center text-xl sm:text-3xl font-bold text-gray-100">{wordQuestion.term}</h2>
      ) : (
        // Grammar prompt: the grammar element itself — descriptions revealed on answer
        <h2 className="max-w-full break-words px-2 text-center text-xl sm:max-w-lg sm:text-3xl font-bold text-gray-100">
          {grammarQuestion!.statement || grammarItem?.statement}
        </h2>
      )}

      {!showingAnswer ? null : wordQuestion ? (
        <>
          {settings.showKoreanHanja && wordQuestion.hanjaReadings && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-px flex-1 bg-amber-500/50"></div>
                <span className="text-xs font-semibold text-amber-400">🀄 {t("sectionKoreanHanja")}</span>
                <div className="h-px flex-1 bg-amber-500/50"></div>
              </div>
              {wordQuestion.hanjaReadings.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-3">
                  {wordQuestion.hanjaReadings.map((r, i) => (
                  <div key={i} className="flex flex-col items-center rounded-lg bg-gray-800 px-3 py-2 text-center min-w-[56px]">
                    <div className="flex items-baseline gap-1 text-base font-medium text-gray-100">
                      <span>{r.simplifiedChar}</span>
                      {r.simplifiedChar !== r.traditionalChar && (
                        <>
                          <span className="text-xs text-gray-500">→</span>
                          <span className="text-amber-300">{r.traditionalChar}</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {r.hunEum.map((h, j) => (
                        <p key={j} className="text-xs text-gray-400">{h}</p>
                      ))}
                    </div>
                  </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-sm text-gray-400">{t("noKoreanHanja")}</p>
              )}
            </div>
          )}
          <div className="text-center space-y-2">
            {visibleDefinitions.map((m, mi) => (
              <div key={mi}>
                {m.partOfSpeech && <p className="text-xs text-gray-500 italic">{m.partOfSpeech}</p>}
                {(() => {
                  const py = m.pinyins && m.pinyins.length > 0
                    ? m.pinyins.join(" / ")
                    : (mi === 0 ? wordQuestion.transliteration : undefined);
                  return py ? <p className="text-sm text-gray-400">{py}</p> : null;
                })()}
                {displayDefEntries(m.text || {}).map(([lang, text]) => (
                  <p key={lang} className="text-xl text-green-400">
                    <span className="text-sm text-gray-400">{LANG_LABEL_MAP[lang] || lang}: </span>{text}
                  </p>
                ))}
              </div>
            ))}
            {definitions.length > VISIBLE_ANSWER_ITEMS && (
              <button
                type="button"
                onClick={() => setShowAllDefinitions((v) => !v)}
                className="mt-1 rounded-md border border-gray-600 bg-gray-700/60 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600 hover:text-gray-100"
              >
                {showAllDefinitions
                  ? `▲ ${t("showFewerDefinitions")}`
                  : `▼ ${t("showMoreDefinitions")} (${definitions.length - VISIBLE_ANSWER_ITEMS})`}
              </button>
            )}
          </div>

          {examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <ExamplesHeader
                showPinyin={showExamplePinyin}
                onToggle={hasExampleReadings(examples) ? toggleExamplePinyin : undefined}
              />
              {visibleExamples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100">
                    <RubyText text={ex.sentence} segments={showExamplePinyin ? ex.segments : undefined} />
                  </p>
                  <TranslationDisplay translation={ex.translation} />
                </div>
              ))}
              {examples.length > VISIBLE_ANSWER_ITEMS && (
                <button
                  type="button"
                  onClick={() => setShowAllExamples((v) => !v)}
                  className="mt-2 w-full rounded-md border border-gray-600 bg-gray-600/30 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600/60 hover:text-gray-100"
                >
                  {showAllExamples
                    ? `▲ ${t("showFewerExamples")}`
                    : `▼ ${t("showMoreExamples")} (${examples.length - VISIBLE_ANSWER_ITEMS})`}
                </button>
              )}
            </div>
          )}


          <div className={`w-full max-w-lg space-y-1 ${usesGroupBControls ? "hidden" : ""}`}>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={flaggedIds.has(wordQuestion.wordId)}
                onChange={() => toggleFlag(wordQuestion.wordId)}
                className="accent-amber-500 w-4 h-4"
              />
              {t("flagForReview")}
            </label>
            {segmentWords.length > 0 && (
              <>
                <p className="text-xs text-gray-500 mt-2">{t("flagSegmentWords")}</p>
                {segmentWords.map((seg) => (
                  <label key={seg.id} className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none pl-4">
                    <input
                      type="checkbox"
                      checked={flaggedIds.has(seg.id)}
                      onChange={() => toggleFlag(seg.id)}
                      className="accent-amber-500 w-4 h-4"
                    />
                    <span className="text-gray-300">{seg.text}</span>
                    {seg.transliteration && (
                      <span className="text-gray-500">({seg.transliteration})</span>
                    )}
                  </label>
                ))}
              </>
            )}
          </div>


        </>
      ) : (
        <>
          {/* Grammar reveal: descriptions (statement pinyin + per-description pinyins included) */}
          {grammarItem && <GrammarDescriptionsPanel item={grammarItem} />}

          {/* Registered examples (if any) */}
          {grammarItem && grammarItem.examples && grammarItem.examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <ExamplesHeader
                showPinyin={showExamplePinyin}
                onToggle={hasExampleReadings(grammarItem.examples) ? toggleExamplePinyin : undefined}
              />
              {grammarItem.examples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100">
                    <RubyText text={ex.sentence} segments={showExamplePinyin ? ex.segments : undefined} />
                  </p>
                  {showExamplePinyin && ex.transliteration && (
                    <p className="text-sm text-gray-500">{ex.transliteration}</p>
                  )}
                  {typeof ex.translation === "string" ? (
                    ex.translation && <p className="text-sm text-gray-400">{ex.translation}</p>
                  ) : (
                    displayGrammarDefEntries(ex.translation).map(([lang, text]) => (
                      <p key={lang} className="text-sm text-gray-400">
                        <span className="mr-1 text-xs font-medium uppercase text-gray-500">{lang}</span>
                        {text}
                      </p>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}



        </>
      )}
      <div data-testid="quiz-actions" className="fixed inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 border-t border-gray-700 bg-gray-900/95 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:static lg:w-full lg:max-w-lg lg:border-0 lg:bg-transparent lg:p-0">
        {question && <GroupBExcludeControl refId={question.kind === "word" ? question.wordId : question.grammarId} kind={question.kind} />}
        {!showingAnswer ? (
          <button onClick={revealAnswer} className="w-full max-w-lg rounded-lg bg-gray-700 px-6 py-3 text-gray-300 hover:bg-gray-600 sm:py-2">
            {wordQuestion ? t("showAnswer") : t("showGrammarAnswer")}
          </button>
        ) : (
          <div className="flex w-full max-w-lg gap-3">
            <button onClick={() => handleGrade(false)} disabled={applyingWeights} className="min-h-11 flex-1 rounded-lg bg-red-600 px-3 py-3 text-white hover:bg-red-700 disabled:opacity-50">{t("iWasWrong")}</button>
            <button onClick={() => handleGrade(true)} disabled={applyingWeights} className="min-h-11 flex-1 rounded-lg bg-green-600 px-3 py-3 text-white hover:bg-green-700 disabled:opacity-50">{t("iWasCorrect")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
