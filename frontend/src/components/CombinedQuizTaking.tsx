import { useState, useEffect, useRef, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP } from "../settings/defaults";
import {
  updateCombinedQuizWeights,
  type CombinedQuizVariant,
} from "../api/combined-quiz";
import { getGroups, removeWordFromGroupB } from "../api/vocab";
import { getGrammarGroups, removeGrammarFromGroupB } from "../api/grammar";
import { getFlaggedWordIds, flagWord, unflagWord } from "../api/flagged";
import { isWeightValid, parseWeightInput, scaleWeightRecord } from "../utils/weightInput";
import RubyText from "./RubyText";
import GrammarDescriptionsPanel from "./GrammarDescriptionsPanel";
import QuizLoadState from "./QuizLoadState";
import QuizSyncBadge from "./QuizSyncBadge";
import { useQuizPrefetch } from "../hooks/useQuizPrefetch";
import { useAnswerOutbox } from "../hooks/useAnswerOutbox";
import { applyCombinedAnswerLocally } from "../utils/quizLocal";
import type {
  CombinedQuizSession,
  CombinedQuizQuestion,
  CombinedQuizWordQuestion,
} from "../types";

const VISIBLE_ANSWER_ITEMS = 4;
/** Reading preference, not session data: kept in localStorage so hiding the
 *  readings once holds for the next question, the next session and both quizzes. */
const EXAMPLE_PINYIN_PREF_KEY = "quizShowExamplePinyin";

interface Props {
  session: CombinedQuizSession;
  onComplete: () => void;
  onBrowse: () => void;
  onStartNew: () => void;
  /** "groupB" talks to /api/group-b-quiz and swaps the "3" key from flag to
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
  const usesGroupBControls = variant === "groupB" || variant === "mixed";
  const { t } = useI18n();
  const { settings, displayDefEntries, displayGrammarDefEntries } = useSettings();
  // `currentSession.questions` is the single source of ORDER and is slim; word payloads and
  // grammar items live in the id-keyed prefetch cache and are merged in at render time.
  const [currentSession, setCurrentSession] = useState(session);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const firstUnanswered = session.questions.findIndex((q) => q.userCorrect === undefined);
    return firstUnanswered === -1 ? session.questions.length : firstUnanswered;
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
  // Group B / mixed variants: items the "3" key has dropped from their Group B groups.
  // Purely local feedback — the current session keeps showing them; they simply
  // stop appearing in future Group B sessions.
  const [removedFromBIds, setRemovedFromBIds] = useState<Set<string>>(new Set());
  const [groupNameMap, setGroupNameMap] = useState<Map<string, string>>(new Map());
  const [originalTotal] = useState(() => session.initialTotal ?? session.questions.length);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [wordGroupsOpen, setWordGroupsOpen] = useState(false);
  const [grammarGroupsOpen, setGrammarGroupsOpen] = useState(false);
  const [domainDraft, setDomainDraft] = useState<{ word: string; grammar: string }>({ word: "1", grammar: "1" });
  const [wordWeightDraft, setWordWeightDraft] = useState<Record<string, string>>({});
  const [grammarWeightDraft, setGrammarWeightDraft] = useState<Record<string, string>>({});
  const [correctDraft, setCorrectDraft] = useState("");
  const [applyingWeights, setApplyingWeights] = useState(false);
  // Session review: every question graded since mount, in grading order (retries counted separately).
  const [sessionLog, setSessionLog] = useState<CombinedQuizQuestion[]>([]);
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
      if (q.userCorrect !== undefined) continue;
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

  // Fetch group names for the per-group progress badges (word + grammar groups).
  useEffect(() => {
    const hasWordGroups =
      session.wordGroupMembership && Object.keys(session.wordGroupMembership).length > 0;
    const hasGrammarGroups =
      session.grammarGroupMembership && Object.keys(session.grammarGroupMembership).length > 0;
    if (!hasWordGroups && !hasGrammarGroups) return;
    Promise.all([
      hasWordGroups ? getGroups(session.language).catch(() => []) : Promise.resolve([]),
      hasGrammarGroups ? getGrammarGroups(session.language).catch(() => []) : Promise.resolve([]),
    ]).then(([wordGroups, grammarGroups]) => {
      setGroupNameMap(
        new Map([...wordGroups, ...grammarGroups].map((g) => [g.id, g.name]))
      );
    });
  }, [session.language, session.wordGroupMembership, session.grammarGroupMembership]);

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
    const wordMembership = currentSession.wordGroupMembership;
    const grammarMembership = currentSession.grammarGroupMembership;
    const unansweredWordIds = new Set(
      orderedQuestions.filter((q) => q.kind === "word" && q.userCorrect === undefined).map((q) => (q as { wordId: string }).wordId)
    );
    const unansweredGrammarIds = new Set(
      orderedQuestions.filter((q) => q.kind === "grammar" && q.userCorrect === undefined).map((q) => (q as { grammarId: string }).grammarId)
    );
    const rows: { id: string; kind: "word" | "grammar"; name: string; remaining: number; total: number }[] = [];
    for (const [gid, ids] of Object.entries(wordMembership ?? {})) {
      rows.push({
        id: gid,
        kind: "word",
        name: groupNameMap.get(gid) ?? gid,
        remaining: ids.filter((id) => unansweredWordIds.has(id)).length,
        total: ids.length,
      });
    }
    for (const [gid, ids] of Object.entries(grammarMembership ?? {})) {
      rows.push({
        id: gid,
        kind: "grammar",
        name: groupNameMap.get(gid) ?? gid,
        remaining: ids.filter((id) => unansweredGrammarIds.has(id)).length,
        total: ids.length,
      });
    }
    return rows.length > 0 ? rows : null;
  }, [currentSession.wordGroupMembership, currentSession.grammarGroupMembership, orderedQuestions, groupNameMap]);

  const hasWordGroups = groupProgress?.some((g) => g.kind === "word") ?? false;
  const hasGrammarGroups = groupProgress?.some((g) => g.kind === "grammar") ?? false;

  function resetExpandedAnswers() {
    setShowAllDefinitions(false);
    setShowAllExamples(false);
  }

  function openWeightsPanel() {
    setDomainDraft({
      word: String(currentSession.domainWeights?.word ?? 1),
      grammar: String(currentSession.domainWeights?.grammar ?? 1),
    });
    setWordWeightDraft(
      Object.fromEntries(
        Object.keys(currentSession.wordGroupMembership ?? {}).map((gid) => [
          gid,
          String(currentSession.wordGroupWeights?.[gid] ?? 1),
        ])
      )
    );
    setGrammarWeightDraft(
      Object.fromEntries(
        Object.keys(currentSession.grammarGroupMembership ?? {}).map((gid) => [
          gid,
          String(currentSession.grammarGroupWeights?.[gid] ?? 1),
        ])
      )
    );
    setCorrectDraft(currentSession.correctWeight !== undefined ? String(currentSession.correctWeight) : "");
    setWeightsOpen(true);
  }

  const domainDraftWordNum = parseWeightInput(domainDraft.word);
  const domainDraftGrammarNum = parseWeightInput(domainDraft.grammar);
  const hasInvalidDomainDraft = domainDraftWordNum === null || domainDraftGrammarNum === null;
  const hasInvalidWordWeightDraft = Object.keys(wordWeightDraft).some((gid) => !isWeightValid(wordWeightDraft[gid], 0));
  const hasInvalidGrammarWeightDraft = Object.keys(grammarWeightDraft).some((gid) => !isWeightValid(grammarWeightDraft[gid], 0));
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
    if (applyingWeights || !canApplyWeights) return;
    setApplyingWeights(true);
    try {
      // Normalize each competing set independently (scale to integers + GCD-reduce): the
      // word/grammar/already-correct domains merge together, each domain's groups compete alone.
      const domainRaw: Record<string, string> = { word: domainDraft.word, grammar: domainDraft.grammar };
      if (correctDraftActive) domainRaw.correct = correctDraft;
      const d = scaleWeightRecord(domainRaw);
      const domainWeights = { word: d.word, grammar: d.grammar };
      const wordGroupWeights = scaleWeightRecord(wordWeightDraft);
      const grammarGroupWeights = scaleWeightRecord(grammarWeightDraft);
      const updated = await updateCombinedQuizWeights(currentSession.language, {
        domainWeights,
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

  // Group B: "3"-key equivalent as a clickable control, plus the post-removal badge.
  function GroupBExcludeControl({ refId, kind }: { refId: string; kind: "word" | "grammar" }) {
    if (!usesGroupBControls) return null;
    if (removedFromBIds.has(refId)) {
      return (
        <p className="w-full max-w-lg rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2.5 text-center text-sm text-amber-300 sm:py-1.5 sm:text-left sm:text-xs">
          ✓ {t("removedFromGroupB")}
        </p>
      );
    }
    return (
      <button
        type="button"
        onClick={() => {
          const call =
            kind === "word"
              ? removeWordFromGroupB(currentSession.language, refId)
              : removeGrammarFromGroupB(currentSession.language, refId);
          void call.catch(() => {});
          setRemovedFromBIds((prev) => new Set([...prev, refId]));
        }}
        className="w-full max-w-lg rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2.5 text-center text-sm font-medium text-amber-300 hover:bg-amber-950/60 sm:bg-transparent sm:py-1.5 sm:text-left sm:text-xs sm:font-normal sm:hover:bg-amber-950/30"
      >
        {/* The "3" hint only means something where there is a keyboard. */}
        <span className="hidden sm:inline">3 · </span>
        {t("removeFromGroupB")}
      </button>
    );
  }

  /** Local-first — see `utils/quizLocal.ts`. The write is queued, never awaited. */
  function handleGrade(correct: boolean) {
    if (!question || gradedIndexRef.current === currentIndex) return;
    gradedIndexRef.current = currentIndex;
    const refId = question.kind === "word" ? question.wordId : question.grammarId;
    const submittedFlagIds = !usesGroupBControls && question.kind === "word" ? Array.from(flaggedIds) : [];

    outbox.enqueue({
      domain: "combined",
      language: currentSession.language,
      variant,
      kind: question.kind,
      refId,
      correct,
      ...(submittedFlagIds.length > 0 ? { flagWordIds: submittedFlagIds } : {}),
    });

    if (submittedFlagIds.length > 0) {
      setAlreadyFlaggedIds((prev) => new Set([...prev, ...submittedFlagIds]));
    }

    setCurrentSession((prev) => applyCombinedAnswerLocally(prev, question.kind, refId, correct));
    setSessionLog((prev) => [...prev, { ...question, userCorrect: correct }]);
    setCurrentIndex((i) => i + 1);
    setShowingAnswer(false);
    resetExpandedAnswers();
    setFlaggedIds(new Set());
  }

  function endSession() {
    if (sessionLog.length === 0) return;
    setSessionReviewIndex(0);
    setSessionReviewActive(true);
  }

  function nextSessionReview() {
    setSessionReviewIndex((i) => i + 1);
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
        // Group B: "3" retires the item from every Group B group it belongs to
        // (both domains), instead of flagging. It stays in the current session.
        event.preventDefault();
        const refId = question.kind === "word" ? question.wordId : question.grammarId;
        const call =
          question.kind === "word"
            ? removeWordFromGroupB(currentSession.language, refId)
            : removeGrammarFromGroupB(currentSession.language, refId);
        void call.catch(() => {});
        setRemovedFromBIds((prev) => new Set([...prev, refId]));
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
  }, [question, showingAnswer, handleGrade, alreadyFlaggedIds, currentSession.language, sessionReviewActive, usesGroupBControls]);


  if (sessionReviewActive) {
    const reviewQ = sessionReviewIndex < sessionLog.length ? sessionLog[sessionReviewIndex] : null;
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
              onClick={() => { onComplete(); onStartNew(); }}
              className="rounded-lg bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-500"
            >
              {t("startNew")}
            </button>
          </div>
        </div>
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
        <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("congratulations")}</h2>
        <p className="text-2xl sm:text-4xl font-semibold text-indigo-400">
          {correct} / {originalTotal}
        </p>
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
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
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

      {/* Per-domain progress (Vocabulary vs Grammar) */}
      {domainProgress.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2 items-center">
          {domainProgress.map((d) => (
            <span
              key={d.kind}
              className={`rounded-full px-3 py-1 text-xs font-medium border ${
                d.kind === "word"
                  ? "bg-blue-900/40 text-blue-300 border-blue-700/50"
                  : "bg-emerald-900/40 text-emerald-300 border-emerald-700/50"
              }`}
            >
              {d.label}: {d.remaining}/{d.total}
            </span>
          ))}
          {hasWordGroups && (
            <button
              onClick={() => setWordGroupsOpen((v) => !v)}
              aria-pressed={wordGroupsOpen}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium text-blue-200 sm:py-1 ${
                wordGroupsOpen
                  ? "border-blue-400 bg-blue-700/60"
                  : "border-blue-800/70 bg-blue-900/30 hover:bg-blue-900/50"
              }`}
            >
              📘 {t("wordGroupsToggle")}
            </button>
          )}
          {hasGrammarGroups && (
            <button
              onClick={() => setGrammarGroupsOpen((v) => !v)}
              aria-pressed={grammarGroupsOpen}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium text-emerald-200 sm:py-1 ${
                grammarGroupsOpen
                  ? "border-emerald-400 bg-emerald-700/60"
                  : "border-emerald-800/70 bg-emerald-900/30 hover:bg-emerald-900/50"
              }`}
            >
              🏷 {t("grammarGroupsToggle")}
            </button>
          )}
          <button
            onClick={() => (weightsOpen ? setWeightsOpen(false) : openWeightsPanel())}
            className="rounded-full border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 sm:py-1"
          >
            ⚖ {t("adjustWeights")}
          </button>
        </div>
      )}

      {/* Mid-session domain + group weight editor */}
      {weightsOpen && (
        <div className="w-full max-w-lg rounded-lg border border-gray-600 bg-gray-800 p-4 space-y-2">
          <p className="text-sm font-medium text-gray-300">{t("adjustWeights")}</p>

          {/* Word domain: its own weight, directly followed by its own groups */}
          <div className="rounded border border-blue-900/50 bg-gray-900/30 p-2 space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <span className="flex-1 min-w-0 truncate font-medium text-blue-300">{t("sectionVocabulary")}</span>
              <input
                type="number"
                min={0}
                value={domainDraft.word}
                title={t("groupWeightHint")}
                aria-label={t("groupWeight")}
                onChange={(e) => {
                  setDomainDraft((prev) => ({ ...prev, word: e.target.value }));
                }}
                className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none sm:w-16 sm:py-1 sm:text-xs ${
                  parseWeightInput(domainDraft.word) === null
                    ? "border-red-500 focus:border-red-400"
                    : "border-gray-600 focus:border-blue-400"
                }`}
              />
            </label>
            {Object.keys(currentSession.wordGroupMembership ?? {}).length > 0 && (
              <details open>
                <summary className="cursor-pointer text-xs font-semibold text-blue-300 select-none">
                  {t("groups")} (
                  {Object.keys(currentSession.wordGroupMembership ?? {}).length})
                </summary>
                <div className="mt-1 space-y-1">
                  {Object.keys(currentSession.wordGroupMembership ?? {}).map((gid) => {
                    const invalid = !isWeightValid(wordWeightDraft[gid], 0);
                    return (
                      <label key={`w-${gid}`} className="flex items-center gap-2 text-sm text-gray-300">
                        <span className="flex-1 min-w-0 truncate pl-4">{groupNameMap.get(gid) ?? gid}</span>
                        <input
                          type="number"
                          min={0}
                          value={wordWeightDraft[gid] ?? "1"}
                          title={t("groupWeightHint")}
                          aria-label={t("groupWeight")}
                          onChange={(e) => {
                            setWordWeightDraft((prev) => ({ ...prev, [gid]: e.target.value }));
                          }}
                          className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none sm:w-16 sm:py-1 sm:text-xs ${
                            invalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-blue-400"
                          }`}
                        />
                      </label>
                    );
                  })}
                </div>
              </details>
            )}
          </div>

          {/* Grammar domain: its own weight, directly followed by its own groups */}
          <div className="rounded border border-emerald-900/50 bg-gray-900/30 p-2 space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <span className="flex-1 min-w-0 truncate font-medium text-emerald-300">{t("sectionGrammar")}</span>
              <input
                type="number"
                min={0}
                value={domainDraft.grammar}
                title={t("groupWeightHint")}
                aria-label={t("groupWeight")}
                onChange={(e) => {
                  setDomainDraft((prev) => ({ ...prev, grammar: e.target.value }));
                }}
                className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none sm:w-16 sm:py-1 sm:text-xs ${
                  parseWeightInput(domainDraft.grammar) === null
                    ? "border-red-500 focus:border-red-400"
                    : "border-gray-600 focus:border-emerald-400"
                }`}
              />
            </label>
            {Object.keys(currentSession.grammarGroupMembership ?? {}).length > 0 && (
              <details open>
                <summary className="cursor-pointer text-xs font-semibold text-emerald-300 select-none">
                  {t("grammarGroups")} (
                  {Object.keys(currentSession.grammarGroupMembership ?? {}).length})
                </summary>
                <div className="mt-1 space-y-1">
                {Object.keys(currentSession.grammarGroupMembership ?? {}).map((gid) => {
                  const invalid = !isWeightValid(grammarWeightDraft[gid], 0);
                  return (
                    <label key={`g-${gid}`} className="flex items-center gap-2 text-sm text-gray-300">
                      <span className="flex-1 min-w-0 truncate pl-4">{groupNameMap.get(gid) ?? gid}</span>
                      <input
                        type="number"
                        min={0}
                        value={grammarWeightDraft[gid] ?? "1"}
                        title={t("groupWeightHint")}
                        aria-label={t("groupWeight")}
                        onChange={(e) => {
                          setGrammarWeightDraft((prev) => ({ ...prev, [gid]: e.target.value }));
                        }}
                        className={`w-20 shrink-0 rounded border bg-gray-700 px-2 py-1.5 text-base text-gray-100 focus:outline-none sm:w-16 sm:py-1 sm:text-xs ${
                          invalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-emerald-400"
                        }`}
                      />
                    </label>
                  );
                })}
                </div>
              </details>
            )}
          </div>

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
              disabled={applyingWeights || !canApplyWeights}
              className="rounded-lg bg-indigo-600 px-3 py-2.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50 sm:py-1.5 sm:text-xs"
            >
              {applyingWeights ? "..." : t("applyWeights")}
            </button>
          </div>
        </div>
      )}

      {/* Per-group progress (word + grammar groups shown as separately labeled rows) — each domain
          collapsed by default and toggled independently via its own 🏷 button since a large group
          count clutters the screen. */}
      {groupProgress && (wordGroupsOpen || grammarGroupsOpen) && (
        <div className="flex flex-col items-center gap-1.5">
          {(["word", "grammar"] as const).map((kind) => {
            if (kind === "word" && !wordGroupsOpen) return null;
            if (kind === "grammar" && !grammarGroupsOpen) return null;
            const rows = groupProgress.filter((g) => g.kind === kind);
            if (rows.length === 0) return null;
            return (
              <div key={kind} className="flex flex-wrap items-center justify-center gap-2">
                <span
                  className={`text-xs font-semibold ${
                    kind === "word" ? "text-blue-300" : "text-emerald-300"
                  }`}
                >
                  {kind === "word" ? t("sectionVocabulary") : t("sectionGrammar")}:
                </span>
                {rows.map((g) => (
                  <span
                    key={g.id}
                    className={`rounded-full px-3 py-1 text-xs font-medium border ${
                      g.remaining === 0
                        ? "bg-green-900/40 text-green-400 border-green-700/50"
                        : kind === "word"
                          ? "bg-blue-900/20 text-gray-300 border-blue-700/50"
                          : "bg-emerald-900/20 text-gray-300 border-emerald-700/50"
                    }`}
                  >
                    {g.name}: {g.remaining}/{g.total}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
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

      {!showingAnswer ? (
        // Same sticky-bottom treatment as the grade buttons: the progress pills above can
        // push this off-screen on a phone, and it is the only way forward.
        <div className="sticky bottom-0 z-10 -mx-4 flex w-[calc(100%+2rem)] flex-col bg-gray-900/95 px-4 py-2 sm:static sm:mx-0 sm:w-auto sm:bg-transparent sm:px-0 sm:py-0">
          <button
            onClick={revealAnswer}
            className="w-full rounded-lg bg-gray-700 px-6 py-3 text-gray-300 hover:bg-gray-600 sm:w-auto sm:py-2"
          >
            {wordQuestion ? t("showAnswer") : t("showGrammarAnswer")}
          </button>
        </div>
      ) : wordQuestion ? (
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

          <GroupBExcludeControl refId={wordQuestion.wordId} kind="word" />

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

          <div className="sticky bottom-0 z-10 -mx-4 flex w-[calc(100%+2rem)] flex-col gap-3 bg-gray-900/95 px-4 py-2 sm:static sm:mx-0 sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:px-0 sm:py-0">
            <button
              onClick={() => handleGrade(false)}
              className="w-full sm:w-auto rounded-lg bg-red-600 px-6 py-3 sm:py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
            <button
              onClick={() => handleGrade(true)}
              className="w-full sm:w-auto rounded-lg bg-green-600 px-6 py-3 sm:py-2 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {t("iWasCorrect")}
            </button>
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

          {grammarQuestion && (
            <GroupBExcludeControl refId={grammarQuestion.grammarId} kind="grammar" />
          )}

          <div className="sticky bottom-0 z-10 -mx-4 flex w-[calc(100%+2rem)] flex-col gap-3 bg-gray-900/95 px-4 py-2 sm:static sm:mx-0 sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:px-0 sm:py-0">
            <button
              onClick={() => handleGrade(false)}
              className="w-full sm:w-auto rounded-lg bg-red-600 px-6 py-3 sm:py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
            <button
              onClick={() => handleGrade(true)}
              className="w-full sm:w-auto rounded-lg bg-green-600 px-6 py-3 sm:py-2 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {t("iWasCorrect")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
