import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useI18n } from "../i18n/context";
import { uiLanguages } from "../i18n/translations";
import { useSettings } from "../settings/context";
import SettingsModal from "./SettingsModal";
import { getCurrentSession, startQuiz } from "../api/quiz";
import { startGrammarQuiz, getCurrentGrammarSession } from "../api/grammar";
import EmptyState from "./EmptyState";
import QuizTaking from "./QuizTaking";
import WordList from "./WordList";
import FlaggedReview from "./FlaggedReview";
import GrammarList from "./GrammarList";
import GrammarQuizTaking from "./GrammarQuizTaking";
import GrammarFilterModal from "./GrammarFilterModal";
import SmartAddWordModal from "./SmartAddWordModal";
import GrammarFormModal from "./GrammarFormModal";
import TranslationView from "./TranslationView";
import SpeakingWritingView from "./SpeakingWritingView";
import ExpressionQuizView from "./ExpressionQuizView";
import ExpressionList from "./ExpressionList";
import QuizFilterModal from "./QuizFilterModal";
import PrintWorksheet from "./PrintWorksheet";
import { getTranslationHistory } from "../api/translation";
import { getSpeakingWritingSession } from "../api/speaking-writing";
import { urlLanguageToIsoCode } from "../settings/defaults";
import { useWordQueue } from "../hooks/useWordQueue";
import { useGrammarQueue } from "../hooks/useGrammarQueue";
import type { QuizSession, GrammarQuizSession } from "../types";

export default function Dashboard() {
  const { language } = useParams<{ language: string }>();
  const isoCode = language ? (urlLanguageToIsoCode(language) ?? language) : "";
  const navigate = useNavigate();
  const location = useLocation();
  const subPath = location.pathname.replace(`/${language}`, "") || "/";
  const { t, language: uiLang, setLanguage } = useI18n();
  const { settings } = useSettings();
  const { enqueue, pendingTerms, queueLength, processingTerms, activeCount, recentResults, clearResults, refreshSignal } = useWordQueue();
  const { enqueue: enqueueGrammar, enqueueUpdate: enqueueGrammarUpdate, pendingTerms: grammarPendingTerms, processingTerms: grammarProcessingTerms, queueLength: grammarQueueLength, activeCount: grammarActiveCount, recentResults: grammarRecentResults, clearResults: clearGrammarResults, refreshSignal: grammarRefreshSignal } = useGrammarQueue();
  const [visibleToast, setVisibleToast] = useState<{ id: string; term: string; success: boolean; error?: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [resumePrompt, setResumePrompt] = useState<QuizSession | null>(null);
  const [pendingFilters, setPendingFilters] = useState<{
    topics: string[];
    categories: string[];
    levels: string[];
    groupIds: string[];
  } | null>(null);
  // Grammar state
  const [activeGrammarQuiz, setActiveGrammarQuiz] = useState<GrammarQuizSession | null>(null);
  const [showGrammarFilterModal, setShowGrammarFilterModal] = useState<string | null>(null);
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

  // Session recovery: navigate to /:language/quiz → fetch active session if state is empty
  useEffect(() => {
    if (subPath !== "/quiz" || activeQuiz) return;
    getCurrentSession(language ?? "").then(session => {
      if (session) setActiveQuiz(session);
      else navigate(`/${language}`, { replace: true });
    }).catch(() => navigate(`/${language}`, { replace: true }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPath, language]);

  // Session recovery: navigate to /:language/grammar-quiz → fetch active session if state is empty
  useEffect(() => {
    if (subPath !== "/grammar-quiz" || activeGrammarQuiz) return;
    getCurrentGrammarSession(language ?? "").then(session => {
      if (session) setActiveGrammarQuiz(session);
      else navigate(`/${language}`, { replace: true });
    }).catch(() => navigate(`/${language}`, { replace: true }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPath, language]);


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

  function handleLanguageSelected(lang: string) {
    setSelectedLanguage(lang);
  }

  async function handleFiltersSelected(filters: { topics: string[]; categories: string[]; levels: string[]; groupIds: string[] }) {
    if (starting || !selectedLanguage) return;
    setStarting(true);
    try {
      // Check for existing in-progress session
      const existing = await getCurrentSession(selectedLanguage);
      if (existing && existing.status === "in-progress") {
        setPendingFilters(filters);
        setResumePrompt(existing);
        return;
      }
      // No existing session — start new
      const session = await startQuiz({
        language: selectedLanguage,
        topics: filters.topics,
        categories: filters.categories,
        levels: filters.levels,
        groupIds: filters.groupIds,
      });
      setSelectedLanguage(null);
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
      setSelectedLanguage(null);
      setStarting(false);
      navigate(`/${language}/quiz`);
    }
  }

  async function handleStartNew() {
    if (!selectedLanguage || !pendingFilters) return;
    const lang = selectedLanguage;
    const filters = pendingFilters;
    setResumePrompt(null);
    setSelectedLanguage(null);
    setPendingFilters(null);
    try {
      const session = await startQuiz({
        language: lang,
        topics: filters.topics,
        categories: filters.categories,
        levels: filters.levels,
        groupIds: filters.groupIds,
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
    setSelectedLanguage(null);
  }

  function handlePrintSelected(
    filters: { topics: string[]; categories: string[]; levels: string[]; groupIds: string[] },
    count: number | null,
  ) {
    if (!selectedLanguage) return;
    const lang = selectedLanguage;
    setSelectedLanguage(null);
    navigate(`/${language}/print-worksheet`, { state: { filters, count, sampleLanguage: lang } });
  }

  function handleQuizComplete() {
    setActiveQuiz(null);
    navigate(`/${language}`);
  }

  function goHome() {
    setActiveQuiz(null);
    setSelectedLanguage(null);
    setResumePrompt(null);
    setPendingFilters(null);
    setStarting(false);
    setActiveGrammarQuiz(null);
    setShowGrammarFilterModal(null);
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
    handleLanguageSelected(language);
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
    setShowGrammarFilterModal(language);
  }

  async function handleGrammarFiltersSelected(filters: { groupIds: string[] }) {
    const lang = showGrammarFilterModal;
    if (!lang) return;
    setShowGrammarFilterModal(null);
    try {
      // Check for existing in-progress session
      const existing = await getCurrentGrammarSession(lang);
      if (existing && existing.status === "in-progress") {
        setActiveGrammarQuiz(existing);
        navigate(`/${language}/grammar-quiz`);
        return;
      }
      const session = await startGrammarQuiz({
        language: lang,
        groupIds: filters.groupIds.length > 0 ? filters.groupIds : undefined,
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

  function handleStartExpressionQuiz() {
    if (!language) return;
    navigate(`/${language}/speaking-writing`, { state: { mode: "new", subMode: "expression-quiz" } });
  }

  function handleBrowseExpressions() {
    if (!language) return;
    navigate(`/${language}/expressions`);
  }

  const showBackButton = (subPath !== "/" && subPath !== "") || !!(selectedLanguage || showGrammarFilterModal || showSmartAdd || grammarFormLanguage);

  return (
    <div className="flex min-h-screen flex-col bg-gray-900">
      <header className="flex items-center justify-between border-b border-gray-700 bg-gray-800 px-3 sm:px-6 py-3">
        <h1 className="text-base sm:text-xl font-bold text-gray-100">{t("appTitle")}</h1>
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
      {showGrammarFilterModal && (
        <GrammarFilterModal
          language={showGrammarFilterModal}
          onStart={handleGrammarFiltersSelected}
          onClose={() => setShowGrammarFilterModal(null)}
        />
      )}
      {showSmartAdd && (
        <SmartAddWordModal
          onSave={() => {}}
          onClose={() => setShowSmartAdd(false)}
          defaultLanguage={language}
          onQueue={enqueue}
          pendingTerms={pendingTerms}
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
          refreshSignal={refreshSignal}
        />
      )}
      {selectedLanguage && !resumePrompt && (
        <QuizFilterModal
          language={selectedLanguage}
          onStart={handleFiltersSelected}
          onClose={handleFilterClose}
          onPrint={handlePrintSelected}
        />
      )}
      {resumePrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-xl bg-gray-800 p-6 shadow-lg">
            <p className="mb-4 text-gray-300">{t("existingQuizFound")}</p>
            <p className="mb-4 text-lg font-semibold text-blue-400">
              {resumePrompt.score.correct} / {resumePrompt.wordIds?.length ?? resumePrompt.questions.length}
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleResume}
                className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-500"
              >
                {t("resumeQuiz")}
              </button>
              <button
                onClick={handleStartNew}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-300 hover:bg-gray-600"
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
            <div className="flex items-center justify-center p-8">
              <span className="text-gray-400">Loading quiz…</span>
            </div>
          )
        ) : subPath === "/browse" ? (
          <WordList
            language={language ?? ""}
            onBack={() => navigate(`/${language}`)}
            initialExpandId={(location.state as { expandId?: string } | null)?.expandId}
            initialSearch={(location.state as { search?: string } | null)?.search}
            refreshSignal={refreshSignal}
            onQueue={enqueue}
            pendingTerms={pendingTerms}
          />
        ) : subPath === "/flagged" ? (
          <FlaggedReview
            language={language ?? ""}
            onBack={() => navigate(`/${language}`)}
          />
        ) : subPath === "/grammar" ? (
          <GrammarList
            language={language ?? ""}
            onBack={() => navigate(`/${language}`)}
            onQueue={enqueue}
            onGrammarQueue={enqueueGrammar}
            onGrammarUpdateQueue={enqueueGrammarUpdate}
            pendingTerms={pendingTerms}
            refreshSignal={refreshSignal + grammarRefreshSignal}
          />
        ) : subPath === "/grammar-quiz" ? (
          activeGrammarQuiz ? (
            <GrammarQuizTaking
              session={activeGrammarQuiz}
              onComplete={() => { setActiveGrammarQuiz(null); navigate(`/${language}`); }}
              onStartNew={handleStartGrammarQuiz}
            />
          ) : (
            <div className="flex items-center justify-center p-8">
              <span className="text-gray-400">Loading quiz…</span>
            </div>
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
            onStartNew={handleStartQuiz}
            onBrowse={handleBrowse}
            onFlaggedReview={handleFlaggedReview}
            onGrammarQuiz={handleStartGrammarQuiz}
            onBrowseGrammar={handleBrowseGrammar}
            onAddWord={handleAddWord}
            onAddGrammar={handleAddGrammar}
            onStartTranslation={() => navigate(`/${language}/translation`, { state: { mode: "new" } })}
            onResumeTranslation={() => navigate(`/${language}/translation`, { state: { mode: "resume" } })}
            hasTranslationHistory={hasTranslationHistory}
            onStartSpeakingWriting={() => navigate(`/${language}/speaking-writing`, { state: { mode: "new" } })}
            onResumeSpeakingWriting={() => navigate(`/${language}/speaking-writing`, { state: { mode: "resume" } })}
            hasSWSession={hasSWSession}
            onStartExpressionQuiz={handleStartExpressionQuiz}
            onBrowseExpressions={handleBrowseExpressions}
            onAddExpression={() => navigate(`/${language}/expressions`)}
          />
        )}
      </main>
    </div>
  );
}
