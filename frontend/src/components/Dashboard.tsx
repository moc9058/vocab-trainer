import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useI18n } from "../i18n/context";
import { uiLanguages } from "../i18n/translations";
import { useSettings } from "../settings/context";
import SettingsModal from "./SettingsModal";
import { getCurrentSession, startQuiz } from "../api/quiz";
import { startGrammarQuiz, getCurrentGrammarSession } from "../api/grammar";
import { startCombinedQuiz, getCurrentCombinedSession } from "../api/combined-quiz";
import EmptyState from "./EmptyState";
import QuizTaking from "./QuizTaking";
import BrowseView from "./BrowseView";
import FlaggedReview from "./FlaggedReview";
import GrammarQuizTaking from "./GrammarQuizTaking";
import CombinedQuizTaking from "./CombinedQuizTaking";
import QuizRecoveryState from "./QuizRecoveryState";
import CombinedQuizFilterModal from "./CombinedQuizFilterModal";
import StudyQuizModal, { type StudyQuizTab } from "./StudyQuizModal";
import SmartAddWordModal from "./SmartAddWordModal";
import GrammarFormModal from "./GrammarFormModal";
import TranslationView from "./TranslationView";
import SpeakingWritingView from "./SpeakingWritingView";
import ExpressionQuizView from "./ExpressionQuizView";
import ExpressionRecallQuizView from "./ExpressionRecallQuizView";
import ExpressionList from "./ExpressionList";
import type { QuizFilters } from "./QuizFilterModal";
import type { CombinedQuizFilters } from "./CombinedQuizFilterModal";
import PrintWorksheet from "./PrintWorksheet";
import { getTranslationHistory } from "../api/translation";
import { getSpeakingWritingSession } from "../api/speaking-writing";
import { urlLanguageToIsoCode } from "../settings/defaults";
import { useWordQueue } from "../hooks/useWordQueue";
import { useGrammarQueue } from "../hooks/useGrammarQueue";
import type { QuizSession, GrammarQuizSession, CombinedQuizSession } from "../types";

export default function Dashboard() {
  const { language } = useParams<{ language: string }>();
  const isoCode = language ? (urlLanguageToIsoCode(language) ?? language) : "";
  const navigate = useNavigate();
  const location = useLocation();
  const subPath = location.pathname.replace(`/${language}`, "") || "/";
  const { t, language: uiLang, setLanguage } = useI18n();
  const { settings } = useSettings();
  const { enqueue, enqueueUpdate, pendingTerms, queueLength, processingTerms, succeededTerms, pendingDraftIds, activeCount, recentResults, clearResults, refreshSignal } = useWordQueue();
  const { enqueue: enqueueGrammar, enqueueUpdate: enqueueGrammarUpdate, pendingTerms: grammarPendingTerms, processingTerms: grammarProcessingTerms, pendingDraftIds: grammarPendingDraftIds, queueLength: grammarQueueLength, activeCount: grammarActiveCount, recentResults: grammarRecentResults, clearResults: clearGrammarResults, refreshSignal: grammarRefreshSignal } = useGrammarQueue();
  const [visibleToast, setVisibleToast] = useState<{ id: string; term: string; success: boolean; error?: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [studyQuizTab, setStudyQuizTab] = useState<StudyQuizTab | null>(null);
  const [resumePrompt, setResumePrompt] = useState<QuizSession | null>(null);
  const [pendingFilters, setPendingFilters] = useState<QuizFilters | null>(null);
  // Grammar state
  const [activeGrammarQuiz, setActiveGrammarQuiz] = useState<GrammarQuizSession | null>(null);
  // Combined quiz state
  const [activeCombinedQuiz, setActiveCombinedQuiz] = useState<CombinedQuizSession | null>(null);
  const [combinedResumePrompt, setCombinedResumePrompt] = useState<CombinedQuizSession | null>(null);
  const [pendingCombinedFilters, setPendingCombinedFilters] = useState<CombinedQuizFilters | null>(null);
  // Group B quiz — an independent system on top of the same combined-quiz machinery,
  // so it gets its own session state and setup modal (no StudyQuizModal tab).
  const [activeGroupBQuiz, setActiveGroupBQuiz] = useState<CombinedQuizSession | null>(null);
  const [showGroupBSetup, setShowGroupBSetup] = useState(false);
  const [groupBResumePrompt, setGroupBResumePrompt] = useState<CombinedQuizSession | null>(null);
  const [pendingGroupBFilters, setPendingGroupBFilters] = useState<CombinedQuizFilters | null>(null);
  // Smart Add Word / Grammar state
  const [showSmartAdd, setShowSmartAdd] = useState(false);
  const [grammarFormLanguage, setGrammarFormLanguage] = useState<string | null>(null);
  // Translation / Speaking-Writing mode derived from URL location state
  const locationState = location.state as { mode?: string; subMode?: string } | null;
  const locationMode = locationState?.mode as "new" | "resume" | undefined;
  const locationSubMode = locationState?.subMode as "expression-quiz" | undefined;
  const translationMode: "new" | "resume" | null = subPath === "/translation" ? (locationMode ?? "resume") : null;
  const speakingWritingMode: "new" | "resume" | null = subPath === "/speaking-writing" ? (locationMode ?? "resume") : null;
  const [hasTranslationHistory, setHasTranslationHistory] = useState(false);
  const [hasSWSession, setHasSWSession] = useState(false);
  // A quiz-session refetch failed at the transport level (typically offline). Bumping
  // `recoveryAttempt` re-runs whichever recovery effect matches the current sub-path.
  const [recoveryError, setRecoveryError] = useState(false);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);

  // Session recovery: a refresh (or a deep link) lands on /:language/quiz with no state, so the
  // session is re-fetched from the server — which also RE-GENERATES it, since every resume
  // endpoint re-draws the unanswered tail with the stored group weights.
  //
  // `null` now means "no such session" and nothing else (see api/quiz.ts). A thrown error is a
  // transport failure, and must NOT be treated as "no session": doing so used to bounce the
  // user to the home screen whenever they refreshed on a weak connection, making an
  // in-progress quiz look like it had vanished.
  useEffect(() => {
    if (subPath !== "/quiz" || activeQuiz) return;
    setRecoveryError(false);
    getCurrentSession(language ?? "").then(session => {
      if (session) setActiveQuiz(session);
      else navigate(`/${language}`, { replace: true });
    }).catch(() => setRecoveryError(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPath, language, recoveryAttempt]);

  // Session recovery: navigate to /:language/grammar-quiz → fetch active session if state is empty
  useEffect(() => {
    if (subPath !== "/grammar-quiz" || activeGrammarQuiz) return;
    setRecoveryError(false);
    getCurrentGrammarSession(language ?? "").then(session => {
      if (session) setActiveGrammarQuiz(session);
      else navigate(`/${language}`, { replace: true });
    }).catch(() => setRecoveryError(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPath, language, recoveryAttempt]);

  // Session recovery: navigate to /:language/combined-quiz → fetch active session if state is empty
  useEffect(() => {
    if (subPath !== "/combined-quiz" || activeCombinedQuiz) return;
    setRecoveryError(false);
    getCurrentCombinedSession(language ?? "").then(session => {
      if (session) setActiveCombinedQuiz(session);
      else navigate(`/${language}`, { replace: true });
    }).catch(() => setRecoveryError(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPath, language, recoveryAttempt]);

  // Session recovery: navigate to /:language/group-b-quiz → fetch active session if state is empty
  useEffect(() => {
    if (subPath !== "/group-b-quiz" || activeGroupBQuiz) return;
    setRecoveryError(false);
    getCurrentCombinedSession(language ?? "", "groupB").then(session => {
      if (session) setActiveGroupBQuiz(session);
      else navigate(`/${language}`, { replace: true });
    }).catch(() => setRecoveryError(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPath, language, recoveryAttempt]);


  // Check for translation history scoped to the current language
  useEffect(() => {
    if (!isoCode) return;
    getTranslationHistory(1, 1, isoCode)
      .then(({ total }) => setHasTranslationHistory(total > 0))
      .catch(() => {});
  }, [subPath, isoCode]);

  // Check for speaking/writing session scoped to the current language
  useEffect(() => {
    if (!isoCode) return;
    (async () => {
      try {
        const sess = await getSpeakingWritingSession(isoCode);
        setHasSWSession(sess !== null && sess.corrections.length > 0);
      } catch {
        setHasSWSession(false);
      }
    })();
  }, [subPath, isoCode]);

  // Show toast for the latest word queue result
  useEffect(() => {
    if (recentResults.length === 0) return;
    const latest = recentResults[0];
    if (visibleToast?.id === latest.id) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setVisibleToast(latest);
    toastTimerRef.current = setTimeout(() => {
      setVisibleToast(null);
      clearResults();
    }, 3000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentResults]);

  // Show toast for the latest grammar queue result
  useEffect(() => {
    if (grammarRecentResults.length === 0) return;
    const latest = grammarRecentResults[0];
    if (visibleToast?.id === latest.id) return;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setVisibleToast({ id: latest.id, term: latest.statement, success: latest.success, error: latest.error });
    toastTimerRef.current = setTimeout(() => {
      setVisibleToast(null);
      clearGrammarResults();
    }, 3000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grammarRecentResults]);

  async function handleFiltersSelected(filters: QuizFilters) {
    if (starting || !language) return;
    setStarting(true);
    try {
      // Check for existing in-progress session
      const existing = await getCurrentSession(language);
      if (existing && existing.status === "in-progress") {
        setPendingFilters(filters);
        setResumePrompt(existing);
        return;
      }
      // No existing session — start new
      const session = await startQuiz({
        language,
        topics: filters.topics,
        categories: filters.categories,
        levels: filters.levels,
        groupIds: filters.groupIds,
        groupWeights: filters.groupWeights,
        correctWeight: filters.correctWeight,
        flaggedOnly: filters.flaggedOnly,
      });
      setStudyQuizTab(null);
      setActiveQuiz(session);
      navigate(`/${language}/quiz`);
    } catch (err) {
      console.error("Failed to start quiz:", err);
      alert(String(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleResume() {
    if (resumePrompt) {
      setActiveQuiz(resumePrompt);
      setResumePrompt(null);
      setPendingFilters(null);
      setStudyQuizTab(null);
      setStarting(false);
      navigate(`/${language}/quiz`);
    }
  }

  async function handleStartNew() {
    if (!language || !pendingFilters) return;
    const filters = pendingFilters;
    setResumePrompt(null);
    setStudyQuizTab(null);
    setPendingFilters(null);
    try {
      const session = await startQuiz({
        language,
        topics: filters.topics,
        categories: filters.categories,
        levels: filters.levels,
        groupIds: filters.groupIds,
        groupWeights: filters.groupWeights,
        correctWeight: filters.correctWeight,
        flaggedOnly: filters.flaggedOnly,
      });
      setActiveQuiz(session);
      navigate(`/${language}/quiz`);
    } catch (err) {
      console.error("Failed to start quiz:", err);
      alert(String(err));
    } finally {
      setStarting(false);
    }
  }

  function handleFilterClose() {
    setStudyQuizTab(null);
  }

  function handlePrintSelected(
    filters: QuizFilters,
    count: number | null,
  ) {
    if (!language) return;
    setStudyQuizTab(null);
    navigate(`/${language}/print-worksheet`, { state: { filters, count, sampleLanguage: language } });
  }

  function handleQuizComplete() {
    setActiveQuiz(null);
    navigate(`/${language}`);
  }

  function goHome() {
    setActiveQuiz(null);
    setStudyQuizTab(null);
    setResumePrompt(null);
    setPendingFilters(null);
    setStarting(false);
    setActiveGrammarQuiz(null);
    setActiveCombinedQuiz(null);
    setCombinedResumePrompt(null);
    setPendingCombinedFilters(null);
    setActiveGroupBQuiz(null);
    setShowGroupBSetup(false);
    setGroupBResumePrompt(null);
    setPendingGroupBFilters(null);
    setShowSmartAdd(false);
    setGrammarFormLanguage(null);
    navigate(`/${language}`);
  }

  function handleAddWord() {
    setShowSmartAdd(true);
  }

  function handleAddGrammar() {
    if (!language) return;
    setGrammarFormLanguage(language);
  }

  async function handleStartQuiz() {
    if (!language) return;
    setStudyQuizTab("word");
  }

  function handleFlaggedReview() {
    if (!language) return;
    navigate(`/${language}/flagged`);
  }

  function handleBrowse() {
    if (!language) return;
    navigate(`/${language}/browse`);
  }

  function handleStartGrammarQuiz() {
    if (!language) return;
    setStudyQuizTab("grammar");
  }

  async function handleGrammarFiltersSelected(filters: { groupIds: string[]; groupWeights: Record<string, number>; correctWeight?: number }) {
    if (!language) return;
    setStudyQuizTab(null);
    try {
      // Check for existing in-progress session
      const existing = await getCurrentGrammarSession(language);
      if (existing && existing.status === "in-progress") {
        setActiveGrammarQuiz(existing);
        navigate(`/${language}/grammar-quiz`);
        return;
      }
      const session = await startGrammarQuiz({
        language,
        groupIds: filters.groupIds.length > 0 ? filters.groupIds : undefined,
        groupWeights: filters.groupIds.length > 0 ? filters.groupWeights : undefined,
        correctWeight: filters.correctWeight,
      });
      setActiveGrammarQuiz(session);
      navigate(`/${language}/grammar-quiz`);
    } catch (err) {
      console.error("Failed to start grammar quiz:", err);
      alert(String(err));
    }
  }

  function handleBrowseGrammar() {
    if (!language) return;
    navigate(`/${language}/grammar`);
  }

  function handleStartCombinedQuiz() {
    if (!language) return;
    setStudyQuizTab("combined");
  }

  async function doStartCombined(filters: CombinedQuizFilters) {
    if (!language) return;
    const session = await startCombinedQuiz({
      language,
      domainWeights: filters.domainWeights,
      correctWeight: filters.correctWeight,
      word: filters.word,
      grammar: filters.grammar,
    });
    setActiveCombinedQuiz(session);
    navigate(`/${language}/combined-quiz`);
  }

  async function handleCombinedFiltersSelected(filters: CombinedQuizFilters) {
    if (starting || !language) return;
    setStarting(true);
    try {
      // Check for existing in-progress combined session
      const existing = await getCurrentCombinedSession(language);
      if (existing && existing.status === "in-progress") {
        setPendingCombinedFilters(filters);
        setCombinedResumePrompt(existing);
        return;
      }
      setStudyQuizTab(null);
      await doStartCombined(filters);
    } catch (err) {
      console.error("Failed to start combined quiz:", err);
      alert(String(err));
    } finally {
      setStarting(false);
    }
  }

  function handleResumeCombined() {
    if (!combinedResumePrompt) return;
    setActiveCombinedQuiz(combinedResumePrompt);
    setCombinedResumePrompt(null);
    setPendingCombinedFilters(null);
    setStudyQuizTab(null);
    setStarting(false);
    navigate(`/${language}/combined-quiz`);
  }

  async function handleStartNewCombined() {
    if (!language || !pendingCombinedFilters) return;
    const filters = pendingCombinedFilters;
    setCombinedResumePrompt(null);
    setStudyQuizTab(null);
    setPendingCombinedFilters(null);
    try {
      await doStartCombined(filters);
    } catch (err) {
      console.error("Failed to start combined quiz:", err);
      alert(String(err));
    } finally {
      setStarting(false);
    }
  }

  function handleStartGroupBQuiz() {
    if (!language) return;
    setShowGroupBSetup(true);
  }

  async function doStartGroupB(filters: CombinedQuizFilters) {
    if (!language) return;
    const session = await startCombinedQuiz({
      language,
      domainWeights: filters.domainWeights,
      correctWeight: filters.correctWeight,
      word: filters.word,
      grammar: filters.grammar,
    }, "groupB");
    setActiveGroupBQuiz(session);
    navigate(`/${language}/group-b-quiz`);
  }

  async function handleGroupBFiltersSelected(filters: CombinedQuizFilters) {
    if (starting || !language) return;
    setStarting(true);
    try {
      const existing = await getCurrentCombinedSession(language, "groupB");
      if (existing && existing.status === "in-progress") {
        setPendingGroupBFilters(filters);
        setGroupBResumePrompt(existing);
        return;
      }
      setShowGroupBSetup(false);
      await doStartGroupB(filters);
    } catch (err) {
      console.error("Failed to start Group B quiz:", err);
      alert(String(err));
    } finally {
      setStarting(false);
    }
  }

  function handleResumeGroupB() {
    if (!groupBResumePrompt) return;
    setActiveGroupBQuiz(groupBResumePrompt);
    setGroupBResumePrompt(null);
    setPendingGroupBFilters(null);
    setShowGroupBSetup(false);
    setStarting(false);
    navigate(`/${language}/group-b-quiz`);
  }

  async function handleStartNewGroupB() {
    if (!language || !pendingGroupBFilters) return;
    const filters = pendingGroupBFilters;
    setGroupBResumePrompt(null);
    setShowGroupBSetup(false);
    setPendingGroupBFilters(null);
    try {
      await doStartGroupB(filters);
    } catch (err) {
      console.error("Failed to start Group B quiz:", err);
      alert(String(err));
    } finally {
      setStarting(false);
    }
  }

  function handleStartExpressionQuiz() {
    if (!language) return;
    navigate(`/${language}/speaking-writing`, { state: { mode: "new", subMode: "expression-quiz" } });
  }

  function handleStartExpressionRecall() {
    if (!language) return;
    navigate(`/${language}/expression-recall`);
  }

  function handleBrowseExpressions() {
    if (!language) return;
    navigate(`/${language}/expressions`);
  }

  const showBackButton = (subPath !== "/" && subPath !== "") || !!(studyQuizTab || showSmartAdd || grammarFormLanguage);

  return (
    <div className="flex min-h-screen flex-col bg-gray-900">
      <header className="flex items-center justify-between border-b border-gray-700 bg-gray-800 px-3 sm:px-6 py-3">
        <button
          onClick={goHome}
          className="text-base sm:text-xl font-bold text-gray-100 hover:text-gray-300 transition-colors"
        >
          {t("appTitle")}
        </button>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-600 overflow-hidden">
            {settings.languageOrder
              .filter((c) => settings.activeUiLanguages.includes(c) && (uiLanguages as readonly string[]).includes(c))
              .map((lang) => (
              <button
                key={lang}
                onClick={() => setLanguage(lang as typeof uiLang)}
                className={`px-2 py-1 text-xs font-medium ${
                  uiLang === lang
                    ? "bg-indigo-600 text-white"
                    : "text-gray-400 hover:bg-gray-700"
                }`}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowSettingsModal(true)}
            className="rounded-lg border border-gray-600 px-2 py-1 text-sm text-gray-400 hover:bg-gray-700"
            title={t("settings")}
          >
            &#9881;
          </button>
          {showBackButton ? (
            <button
              onClick={goHome}
              className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
            >
              {t("back")}
            </button>
          ) : (
            <button
              onClick={() => navigate("/")}
              className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
            >
              ← {t("languages")}
            </button>
          )}
        </div>
      </header>
      {showSettingsModal && (
        <SettingsModal onClose={() => setShowSettingsModal(false)} currentLanguageCode={isoCode} />
      )}
      {showSmartAdd && (
        <SmartAddWordModal
          onSave={() => {}}
          onClose={() => setShowSmartAdd(false)}
          defaultLanguage={language}
          onQueue={enqueue}
          pendingTerms={pendingTerms}
          succeededTerms={succeededTerms}
          refreshSignal={refreshSignal}
          onJumpToWord={(id, term) => {
            setShowSmartAdd(false);
            navigate(`/${language}/browse`, { state: { expandId: id, search: term } });
          }}
        />
      )}
      {grammarFormLanguage && (
        <GrammarFormModal
          language={grammarFormLanguage}
          onSave={() => setGrammarFormLanguage(null)}
          onClose={() => setGrammarFormLanguage(null)}
          onQueue={enqueue}
          onGrammarQueue={enqueueGrammar}
          onGrammarUpdateQueue={enqueueGrammarUpdate}
          pendingTerms={pendingTerms}
          succeededTerms={succeededTerms}
          refreshSignal={refreshSignal}
        />
      )}
      {studyQuizTab && !resumePrompt && !combinedResumePrompt && language && (
        <StudyQuizModal
          language={language}
          initialTab={studyQuizTab}
          onClose={handleFilterClose}
          onStartWord={handleFiltersSelected}
          onPrintWord={handlePrintSelected}
          onStartGrammar={handleGrammarFiltersSelected}
          onStartCombined={handleCombinedFiltersSelected}
        />
      )}
      {showGroupBSetup && !groupBResumePrompt && language && (
        <CombinedQuizFilterModal
          language={language}
          groupCategory="B"
          showFlaggedToggle={false}
          onStart={handleGroupBFiltersSelected}
          onClose={() => setShowGroupBSetup(false)}
        />
      )}
      {groupBResumePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl bg-gray-800 p-5 shadow-lg sm:p-6">
            <p className="mb-4 text-gray-300">{t("existingGroupBQuizFound")}</p>
            <p className="mb-4 text-lg font-semibold text-amber-400">
              {groupBResumePrompt.score.correct} / {groupBResumePrompt.initialTotal ?? groupBResumePrompt.questions.length}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                onClick={handleResumeGroupB}
                className="flex-1 rounded-lg bg-amber-600 px-4 py-3 text-white hover:bg-amber-500 sm:py-2"
              >
                {t("resumeQuiz")}
              </button>
              <button
                onClick={handleStartNewGroupB}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-3 text-gray-300 hover:bg-gray-600 sm:py-2"
              >
                {t("startNewQuiz")}
              </button>
            </div>
          </div>
        </div>
      )}
      {combinedResumePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl bg-gray-800 p-5 shadow-lg sm:p-6">
            <p className="mb-4 text-gray-300">{t("existingCombinedQuizFound")}</p>
            <p className="mb-4 text-lg font-semibold text-indigo-400">
              {combinedResumePrompt.score.correct} / {combinedResumePrompt.initialTotal ?? combinedResumePrompt.questions.length}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                onClick={handleResumeCombined}
                className="flex-1 rounded-lg bg-indigo-600 px-4 py-3 text-white hover:bg-indigo-500 sm:py-2"
              >
                {t("resumeQuiz")}
              </button>
              <button
                onClick={handleStartNewCombined}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-3 text-gray-300 hover:bg-gray-600 sm:py-2"
              >
                {t("startNewQuiz")}
              </button>
            </div>
          </div>
        </div>
      )}
      {resumePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl bg-gray-800 p-5 shadow-lg sm:p-6">
            <p className="mb-4 text-gray-300">{t("existingQuizFound")}</p>
            <p className="mb-4 text-lg font-semibold text-blue-400">
              {resumePrompt.score.correct} / {resumePrompt.wordIds?.length ?? resumePrompt.questions.length}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                onClick={handleResume}
                className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-white hover:bg-blue-500 sm:py-2"
              >
                {t("resumeQuiz")}
              </button>
              <button
                onClick={handleStartNew}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-3 text-gray-300 hover:bg-gray-600 sm:py-2"
              >
                {t("startNewQuiz")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Queue status pill — shows every in-flight word/grammar. With parallel
          processing (CONCURRENCY in useWordQueue/useGrammarQueue), up to N terms can be
          in the "processing" amber state simultaneously; the rest are
          queued. `pendingTerms` is the union; `processingTerms` is the
          currently-running subset. */}
      {(activeCount + grammarActiveCount > 0 || queueLength + grammarQueueLength > 0) && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-md flex-wrap items-center gap-1.5 rounded-2xl bg-gray-700 px-4 py-2 text-sm text-gray-200 shadow-lg border border-gray-600">
          <span className="animate-spin inline-block">⟳</span>
          <span className="text-xs text-gray-300">Generating:</span>
          {[...[...pendingTerms, ...grammarPendingTerms]].map((term) => (
            <span
              key={term}
              className={`rounded-full px-2 py-0.5 text-xs ${
                processingTerms.has(term) || grammarProcessingTerms.has(term)
                  ? "border border-amber-400/60 bg-amber-900/40 text-amber-100"
                  : "border border-gray-500/40 bg-gray-800/60 text-gray-300"
              }`}
              title={processingTerms.has(term) || grammarProcessingTerms.has(term) ? "Processing" : "Queued"}
            >
              {term}
            </span>
          ))}
        </div>
      )}
      {/* Toast notification (shown above the pill if both visible) */}
      {visibleToast && (
        <div className={`fixed z-50 rounded-lg px-4 py-2 text-sm shadow-lg border transition-all ${activeCount + grammarActiveCount > 0 || queueLength + grammarQueueLength > 0 ? "bottom-16 right-4" : "bottom-4 right-4"} ${visibleToast.success ? "bg-green-900/90 border-green-700 text-green-200" : "bg-red-900/90 border-red-700 text-red-200"}`}>
          {visibleToast.success
            ? `✓ "${visibleToast.term}" added`
            : `✗ "${visibleToast.term}" failed${visibleToast.error ? `: ${visibleToast.error}` : ""}`}
        </div>
      )}
      <main className="flex-1">
        {subPath === "/quiz" ? (
          activeQuiz ? (
            <QuizTaking
              session={activeQuiz}
              onComplete={handleQuizComplete}
              onBrowse={handleBrowse}
              onStartNew={handleStartQuiz}
            />
          ) : (
            <QuizRecoveryState error={recoveryError} onRetry={() => setRecoveryAttempt((n) => n + 1)} onHome={goHome} />
          )
        ) : subPath === "/browse" || subPath === "/grammar" || subPath === "/import" ? (
          <BrowseView
            language={language ?? ""}
            initialTab={subPath === "/grammar" ? "grammar" : subPath === "/import" ? "import" : "word"}
            onTabChange={(tab) =>
              navigate(`/${language}/${tab === "word" ? "browse" : tab}`, { replace: true })
            }
            onBack={() => navigate(`/${language}`)}
            initialExpandId={(location.state as { expandId?: string } | null)?.expandId}
            initialSearch={(location.state as { search?: string } | null)?.search}
            refreshSignal={refreshSignal}
            grammarRefreshSignal={grammarRefreshSignal}
            onQueue={enqueue}
            onQueueEdit={enqueueUpdate}
            onGrammarQueue={enqueueGrammar}
            onGrammarUpdateQueue={enqueueGrammarUpdate}
            pendingTerms={pendingTerms}
            succeededTerms={succeededTerms}
            pendingDraftIds={pendingDraftIds}
            grammarPendingTerms={grammarPendingTerms}
            grammarPendingDraftIds={grammarPendingDraftIds}
          />
        ) : subPath === "/flagged" ? (
          <FlaggedReview
            language={language ?? ""}
            onBack={() => navigate(`/${language}`)}
          />
        ) : subPath === "/grammar-quiz" ? (
          activeGrammarQuiz ? (
            <GrammarQuizTaking
              session={activeGrammarQuiz}
              onComplete={() => { setActiveGrammarQuiz(null); navigate(`/${language}`); }}
              onStartNew={handleStartGrammarQuiz}
            />
          ) : (
            <QuizRecoveryState error={recoveryError} onRetry={() => setRecoveryAttempt((n) => n + 1)} onHome={goHome} />
          )
        ) : subPath === "/combined-quiz" ? (
          activeCombinedQuiz ? (
            // `key` is load-bearing: both variants render into the same slot of this ternary,
            // so without it React reuses the instance across Group A ↔ Group B and the stale
            // `variant` would post answers to the wrong session.
            <CombinedQuizTaking
              key="combined"
              session={activeCombinedQuiz}
              onComplete={() => { setActiveCombinedQuiz(null); navigate(`/${language}`); }}
              onBrowse={handleBrowse}
              onStartNew={handleStartCombinedQuiz}
            />
          ) : (
            <QuizRecoveryState error={recoveryError} onRetry={() => setRecoveryAttempt((n) => n + 1)} onHome={goHome} />
          )
        ) : subPath === "/group-b-quiz" ? (
          activeGroupBQuiz ? (
            <CombinedQuizTaking
              key="groupB"
              session={activeGroupBQuiz}
              variant="groupB"
              onComplete={() => { setActiveGroupBQuiz(null); navigate(`/${language}`); }}
              onBrowse={handleBrowse}
              onStartNew={handleStartGroupBQuiz}
            />
          ) : (
            <QuizRecoveryState error={recoveryError} onRetry={() => setRecoveryAttempt((n) => n + 1)} onHome={goHome} />
          )
        ) : subPath === "/print-worksheet" ? (
          (() => {
            const st = (location.state as {
              filters?: { topics: string[]; categories: string[]; levels: string[]; groupIds: string[] };
              count?: number | null;
              sampleLanguage?: string;
            } | null);
            if (!st || !st.filters || st.count === undefined || !st.sampleLanguage) {
              navigate(`/${language}`, { replace: true });
              return null;
            }
            return (
              <PrintWorksheet
                language={st.sampleLanguage}
                filters={st.filters}
                count={st.count}
                onBack={() => navigate(`/${language}`)}
              />
            );
          })()
        ) : subPath === "/expression-recall" ? (
          // A real sub-path, unlike the writing quiz next door, which rides on
          // `location.state.subMode` and so cannot survive a refresh.
          // `isoCode`, NOT `language`: expressions are stored under ISO codes.
          <ExpressionRecallQuizView language={isoCode} onBack={() => navigate(`/${language}`)} />
        ) : subPath === "/expressions" ? (
          <ExpressionList
            language={isoCode}
            onBack={() => navigate(`/${language}`)}
          />
        ) : subPath === "/speaking-writing" ? (
          locationSubMode === "expression-quiz" ? (
            <ExpressionQuizView
              language={isoCode}
              onBack={() => navigate(`/${language}`)}
            />
          ) : (
            <SpeakingWritingView mode={speakingWritingMode!} language={isoCode} />
          )
        ) : subPath === "/translation" ? (
          <TranslationView mode={translationMode!} language={isoCode} />
        ) : (
          <EmptyState
            language={language ?? ""}
            onResume={(session) => { setActiveQuiz(session); navigate(`/${language}/quiz`); }}
            onResumeGrammar={(session) => { setActiveGrammarQuiz(session); navigate(`/${language}/grammar-quiz`); }}
            onResumeCombined={(session) => { setActiveCombinedQuiz(session); navigate(`/${language}/combined-quiz`); }}
            onCombinedQuiz={handleStartCombinedQuiz}
            onResumeGroupB={(session) => { setActiveGroupBQuiz(session); navigate(`/${language}/group-b-quiz`); }}
            onGroupBQuiz={handleStartGroupBQuiz}
            onStartNew={handleStartQuiz}
            onBrowse={handleBrowse}
            onFlaggedReview={handleFlaggedReview}
            onGrammarQuiz={handleStartGrammarQuiz}
            onBrowseGrammar={handleBrowseGrammar}
            onImport={() => navigate(`/${language}/import`)}
            onAddWord={handleAddWord}
            onAddGrammar={handleAddGrammar}
            onStartTranslation={() => navigate(`/${language}/translation`, { state: { mode: "new" } })}
            onResumeTranslation={() => navigate(`/${language}/translation`, { state: { mode: "resume" } })}
            hasTranslationHistory={hasTranslationHistory}
            onStartSpeakingWriting={() => navigate(`/${language}/speaking-writing`, { state: { mode: "new" } })}
            onResumeSpeakingWriting={() => navigate(`/${language}/speaking-writing`, { state: { mode: "resume" } })}
            hasSWSession={hasSWSession}
            onStartExpressionQuiz={handleStartExpressionQuiz}
            onStartExpressionRecall={handleStartExpressionRecall}
            onBrowseExpressions={handleBrowseExpressions}
            onAddExpression={() => navigate(`/${language}/expressions`)}
          />
        )}
      </main>
    </div>
  );
}
