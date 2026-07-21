import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP } from "../settings/defaults";
import { answerCombinedQuestion, getCombinedQuizQuestions, updateCombinedQuizWeights } from "../api/combined-quiz";
import { getGroups } from "../api/vocab";
import { getGrammarGroups } from "../api/grammar";
import { getFlaggedWordIds, flagWord, unflagWord } from "../api/flagged";
import { fetchJson } from "../api/client";
import { isWeightValid, parseWeightInput } from "../utils/weightInput";
import RubyText from "./RubyText";
import type {
  CombinedQuizSession,
  CombinedQuizQuestion,
  Grammar,
} from "../types";

const BATCH_SIZE = 50;
const VISIBLE_ANSWER_ITEMS = 4;
// How many upcoming grammar questions to prefetch item details for.
const GRAMMAR_PREFETCH = 5;

interface Props {
  session: CombinedQuizSession;
  onComplete: () => void;
  onBrowse: () => void;
  onStartNew: () => void;
}

function questionKey(q: CombinedQuizQuestion): string {
  return q.kind === "word" ? `w:${q.wordId}` : `g:${q.grammarId}`;
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

export default function CombinedQuizTaking({ session, onComplete, onBrowse, onStartNew }: Props) {
  const { t } = useI18n();
  const { settings, displayDefEntries, displayGrammarDefEntries } = useSettings();
  const [currentSession, setCurrentSession] = useState(session);
  const [questions, setQuestions] = useState<CombinedQuizQuestion[]>(session.questions);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [showAllDefinitions, setShowAllDefinitions] = useState(false);
  const [showAllExamples, setShowAllExamples] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [alreadyFlaggedIds, setAlreadyFlaggedIds] = useState<Set<string>>(new Set());
  const [grammarCache, setGrammarCache] = useState<Map<string, Grammar>>(new Map());
  const [groupNameMap, setGroupNameMap] = useState<Map<string, string>>(new Map());
  const [originalTotal] = useState(() => session.initialTotal ?? session.questions.length);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [wordGroupsOpen, setWordGroupsOpen] = useState(false);
  const [grammarGroupsOpen, setGrammarGroupsOpen] = useState(false);
  const [domainDraft, setDomainDraft] = useState<{ word: string; grammar: string }>({ word: "1", grammar: "1" });
  const [wordWeightDraft, setWordWeightDraft] = useState<Record<string, string>>({});
  const [grammarWeightDraft, setGrammarWeightDraft] = useState<Record<string, string>>({});
  const [applyingWeights, setApplyingWeights] = useState(false);

  const fetchedCountRef = useRef(0);
  const fetchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const submittingRef = useRef(false);
  const totalQuestionsRef = useRef(session.questions.length);

  const fetchBatch = useCallback((offset: number, limit: number) => {
    const request = fetchQueueRef.current.then(async () => {
      const { questions: batch, total } = await getCombinedQuizQuestions(session.language, offset, limit);
      totalQuestionsRef.current = total;
      fetchedCountRef.current = Math.max(fetchedCountRef.current, offset + batch.length);
      setQuestions((prev) => {
        const newQuestions = [...prev];
        for (let i = 0; i < batch.length; i++) {
          const idx = offset + i;
          if (idx >= newQuestions.length) {
            newQuestions.push(batch[i]);
          } else {
            newQuestions[idx] = { ...newQuestions[idx], ...batch[i] } as CombinedQuizQuestion;
          }
        }
        return newQuestions;
      });
    });
    fetchQueueRef.current = request.catch(() => {});
    return request;
  }, [session.language]);

  // Initial load: fetch first batch starting at the first unanswered question
  useEffect(() => {
    const firstUnanswered = session.questions.findIndex((q) => q.userCorrect === undefined);
    const startOffset = Math.max(0, firstUnanswered === -1 ? 0 : firstUnanswered);
    setCurrentIndex(firstUnanswered === -1 ? session.questions.length : firstUnanswered);

    fetchBatch(startOffset, BATCH_SIZE).then(() => setLoading(false));
  }, [fetchBatch, session.questions]);

  // Prefetch next batch when halfway through the loaded questions
  useEffect(() => {
    if (loading) return;
    const loadedUnanswered = questions.filter((q) => q.userCorrect === undefined).length;
    const halfway = Math.floor(loadedUnanswered / 2);
    const answeredSinceLoad = questions.filter((q) => q.userCorrect !== undefined).length - (session.questions.filter((q) => q.userCorrect !== undefined).length);

    if (answeredSinceLoad >= halfway && fetchedCountRef.current < totalQuestionsRef.current) {
      fetchBatch(fetchedCountRef.current, BATCH_SIZE);
    }
  }, [currentIndex, loading, questions, fetchBatch, session.questions]);

  useEffect(() => {
    getFlaggedWordIds(session.language)
      .then(({ wordIds }) => setAlreadyFlaggedIds(new Set(wordIds)))
      .catch(() => setAlreadyFlaggedIds(new Set()));
  }, [session.language]);

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

  // Fetch grammar item details (statement/descriptions) for the current + next few
  // grammar questions so the answer reveal is instant.
  useEffect(() => {
    const upcoming = questions.slice(currentIndex, currentIndex + GRAMMAR_PREFETCH);
    const ids = [...new Set(
      upcoming.filter((q) => q.kind === "grammar").map((q) => q.grammarId)
    )].filter((id) => !grammarCache.has(id));
    for (const id of ids) {
      fetchJson<Grammar>(
        `/api/grammar/${encodeURIComponent(session.language)}/items/${encodeURIComponent(id)}`
      )
        .then((item) => {
          setGrammarCache((prev) => new Map(prev).set(id, item));
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, questions, session.language]);

  // Mobile: the page scrolls when an answer is tall (min-h-full container), so
  // reset to the top on each new question — otherwise the prompt stays off-screen.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [currentIndex]);

  const question = currentIndex < questions.length ? questions[currentIndex] : null;
  const isComplete = currentSession.status === "completed";
  const wordQuestion = question?.kind === "word" ? question : null;
  const grammarQuestion = question?.kind === "grammar" ? question : null;
  const grammarItem = grammarQuestion ? grammarCache.get(grammarQuestion.grammarId) : null;

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
    for (const q of questions) {
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
  }, [questions, t]);

  // Per-group progress for word groups and grammar groups combined.
  const groupProgress = useMemo(() => {
    const wordMembership = currentSession.wordGroupMembership;
    const grammarMembership = currentSession.grammarGroupMembership;
    const unansweredWordIds = new Set(
      questions.filter((q) => q.kind === "word" && q.userCorrect === undefined).map((q) => (q as { wordId: string }).wordId)
    );
    const unansweredGrammarIds = new Set(
      questions.filter((q) => q.kind === "grammar" && q.userCorrect === undefined).map((q) => (q as { grammarId: string }).grammarId)
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
  }, [currentSession.wordGroupMembership, currentSession.grammarGroupMembership, questions, groupNameMap]);

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
    setWeightsOpen(true);
  }

  const domainDraftWordNum = parseWeightInput(domainDraft.word);
  const domainDraftGrammarNum = parseWeightInput(domainDraft.grammar);
  const hasInvalidDomainDraft = domainDraftWordNum === null || domainDraftGrammarNum === null;
  const hasInvalidWordWeightDraft = Object.keys(wordWeightDraft).some((gid) => !isWeightValid(wordWeightDraft[gid], 0));
  const hasInvalidGrammarWeightDraft = Object.keys(grammarWeightDraft).some((gid) => !isWeightValid(grammarWeightDraft[gid], 0));
  const canApplyWeights =
    !hasInvalidDomainDraft &&
    !hasInvalidWordWeightDraft &&
    !hasInvalidGrammarWeightDraft &&
    !((domainDraftWordNum ?? 0) <= 0 && (domainDraftGrammarNum ?? 0) <= 0);

  // Apply new domain/group weights mid-session: the server reorders the
  // unanswered tail and returns the full session; re-sync local order and jump
  // to the first unanswered question of the new order.
  async function applyWeights() {
    if (applyingWeights || !canApplyWeights) return;
    setApplyingWeights(true);
    try {
      const domainWeights = {
        word: Math.max(0, Math.floor(domainDraftWordNum ?? 0)),
        grammar: Math.max(0, Math.floor(domainDraftGrammarNum ?? 0)),
      };
      const wordGroupWeights = Object.fromEntries(
        Object.entries(wordWeightDraft).map(([gid, v]) => [gid, Math.max(0, Math.floor(parseWeightInput(v) ?? 0))])
      );
      const grammarGroupWeights = Object.fromEntries(
        Object.entries(grammarWeightDraft).map(([gid, v]) => [gid, Math.max(0, Math.floor(parseWeightInput(v) ?? 0))])
      );
      const updated = await updateCombinedQuizWeights(currentSession.language, {
        domainWeights,
        ...(Object.keys(wordGroupWeights).length > 0 ? { wordGroupWeights } : {}),
        ...(Object.keys(grammarGroupWeights).length > 0 ? { grammarGroupWeights } : {}),
      });
      const hydratedByKey = new Map(questions.map((q) => [questionKey(q), q]));
      setQuestions(
        updated.questions.map((q) => ({
          ...hydratedByKey.get(questionKey(q)),
          ...q,
        }) as CombinedQuizQuestion)
      );
      setCurrentSession(updated);
      totalQuestionsRef.current = updated.questions.length;
      const firstUnanswered = updated.questions.findIndex((q) => q.userCorrect === undefined);
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

  async function handleGrade(correct: boolean) {
    if (!question || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const submittedFlagIds = question.kind === "word" ? Array.from(flaggedIds) : [];
    try {
      const { session: updatedSession } = await answerCombinedQuestion({
        language: currentSession.language,
        kind: question.kind,
        refId: question.kind === "word" ? question.wordId : question.grammarId,
        correct,
        flagWordIds: submittedFlagIds.length > 0 ? submittedFlagIds : undefined,
      });

      if (submittedFlagIds.length > 0) {
        setAlreadyFlaggedIds((prev) => new Set([...prev, ...submittedFlagIds]));
      }

      setQuestions((prev) => {
        const hydratedByKey = new Map(prev.map((q) => [questionKey(q), q]));
        return updatedSession.questions.map((q) => ({
          ...hydratedByKey.get(questionKey(q)),
          ...q,
        }) as CombinedQuizQuestion);
      });
      setCurrentSession(updatedSession);
      totalQuestionsRef.current = updatedSession.questions.length;
      if (!correct) {
        await fetchBatch(currentIndex + 1, BATCH_SIZE);
      }

      setCurrentIndex((i) => i + 1);
      setShowingAnswer(false);
      resetExpandedAnswers();
      setFlaggedIds(new Set());
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Ignore shortcuts while typing in a form control (e.g. the weights panel).
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (!showingAnswer) {
        if (question && !event.repeat && (event.key === " " || event.code === "Space")) {
          event.preventDefault();
          revealAnswer();
        }
        return;
      }

      if (submittingRef.current || event.repeat) return;
      if (event.key === "1") {
        event.preventDefault();
        void handleGrade(false);
      } else if (event.key === "2") {
        event.preventDefault();
        void handleGrade(true);
      } else if (event.key === "3" && question?.kind === "word") {
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
  }, [question, showingAnswer, submitting, handleGrade, alreadyFlaggedIds, currentSession.language]);

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <p className="text-gray-400">Loading questions...</p>
      </div>
    );
  }

  if (isComplete || (!question && currentIndex >= questions.length)) {
    const { correct } = currentSession.score;
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
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

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <p className="text-sm text-gray-400">
        {currentSession.score.correct} / {originalTotal}
      </p>

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
              className={`rounded-full border px-3 py-1 text-xs font-medium text-blue-200 ${
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
              className={`rounded-full border px-3 py-1 text-xs font-medium text-emerald-200 ${
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
            className="rounded-full border border-gray-600 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
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
                className={`w-16 shrink-0 rounded border bg-gray-700 px-2 py-1 text-xs text-gray-100 focus:outline-none ${
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
                          className={`w-16 shrink-0 rounded border bg-gray-700 px-2 py-1 text-xs text-gray-100 focus:outline-none ${
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
                className={`w-16 shrink-0 rounded border bg-gray-700 px-2 py-1 text-xs text-gray-100 focus:outline-none ${
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
                        className={`w-16 shrink-0 rounded border bg-gray-700 px-2 py-1 text-xs text-gray-100 focus:outline-none ${
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

          {!canApplyWeights && (
            <p className="text-xs text-red-400">{t("groupWeightRequiredHint")}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setWeightsOpen(false)}
              className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700"
            >
              {t("cancel")}
            </button>
            <button
              onClick={applyWeights}
              disabled={applyingWeights || !canApplyWeights}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50"
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
        <h2 className="max-w-lg text-center text-xl sm:text-3xl font-bold text-gray-100">
          {grammarQuestion!.statement || grammarItem?.statement}
        </h2>
      )}

      {!showingAnswer ? (
        <button
          onClick={revealAnswer}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {wordQuestion ? t("showAnswer") : t("showGrammarAnswer")}
        </button>
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
              <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
              {visibleExamples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100"><RubyText text={ex.sentence} segments={ex.segments} /></p>
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

          <div className="w-full max-w-lg space-y-1">
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

          <div className="sticky bottom-0 z-10 flex w-full flex-col gap-3 bg-gray-900/95 py-2 sm:static sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:py-0">
            <button
              disabled={submitting}
              onClick={() => handleGrade(false)}
              className="w-full sm:w-auto rounded-lg bg-red-600 px-6 py-3 sm:py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
            <button
              disabled={submitting}
              onClick={() => handleGrade(true)}
              className="w-full sm:w-auto rounded-lg bg-green-600 px-6 py-3 sm:py-2 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {t("iWasCorrect")}
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Grammar reveal: descriptions */}
          {grammarItem && (
            <div className="w-full max-w-lg rounded-lg bg-gray-800 border border-gray-600 p-4">
              {grammarItem.descriptions?.map((d, di) => {
                const entries = displayDefEntries(d.text || {});
                const rows = entries.length > 0 ? entries : Object.entries(d.text || {});
                return (
                  <div key={di} className="mb-2 last:mb-0">
                    {d.partOfSpeech && (
                      <span className="mr-2 rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300">
                        {d.partOfSpeech}
                      </span>
                    )}
                    {rows.map(([lang, text]) => (
                      <p key={lang} className="text-sm text-gray-300 whitespace-pre-line">
                        <span className="text-xs text-gray-500">[{lang}] </span>
                        {text}
                      </p>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {/* Registered examples (if any) */}
          {grammarItem && grammarItem.examples && grammarItem.examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
              {grammarItem.examples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100">
                    <RubyText text={ex.sentence} segments={ex.segments} />
                  </p>
                  {ex.transliteration && (
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

          <div className="sticky bottom-0 z-10 flex w-full flex-col gap-3 bg-gray-900/95 py-2 sm:static sm:w-auto sm:flex-row sm:gap-4 sm:bg-transparent sm:py-0">
            <button
              disabled={submitting}
              onClick={() => handleGrade(false)}
              className="w-full sm:w-auto rounded-lg bg-red-600 px-6 py-3 sm:py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
            <button
              disabled={submitting}
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
