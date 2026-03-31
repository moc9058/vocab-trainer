import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { uiLanguages } from "../i18n/translations";
import { useSettings } from "../settings/context";
import SettingsModal from "./SettingsModal";
import { getCurrentSession, startQuiz } from "../api/quiz";
import { getFilters, getTransliterationMap } from "../api/vocab";
import { startGrammarQuiz, getCurrentGrammarSession } from "../api/grammar";
import { fetchJson } from "../api/client";
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
import MetricsView from "./MetricsView";
import LanguageSelectModal from "./LanguageSelectModal";
import LevelSelectModal from "./LevelSelectModal";
import QuizFilterModal from "./QuizFilterModal";
import { getTranslationHistory } from "../api/translation";
import { getSpeakingWritingSession } from "../api/speaking-writing";
import type { QuizSession, GrammarQuizSession } from "../types";

export default function Dashboard() {
  const { t, language, setLanguage } = useI18n();
  const { settings } = useSettings();
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [showLanguageModal, setShowLanguageModal] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [selectedLevels, setSelectedLevels] = useState<string[] | null>(null);
  const [resumePrompt, setResumePrompt] = useState<QuizSession | null>(null);
  const [pendingFilters, setPendingFilters] = useState<{
    topics: string[];
    categories: string[];
  } | null>(null);
  const [browsingLanguage, setBrowsingLanguage] = useState<string | null>(null);
  const [showBrowseLanguageModal, setShowBrowseLanguageModal] = useState(false);
  const [flaggedReviewLanguage, setFlaggedReviewLanguage] = useState<string | null>(null);
  const [showFlaggedLanguageModal, setShowFlaggedLanguageModal] = useState(false);
  const [transliterationMap, setPinyinMap] = useState<Record<string, string>>({});
  // Grammar state
  const [activeGrammarQuiz, setActiveGrammarQuiz] = useState<GrammarQuizSession | null>(null);
  const [browsingGrammarLanguage, setBrowsingGrammarLanguage] = useState<string | null>(null);
  const [showGrammarLanguageModal, setShowGrammarLanguageModal] = useState(false);
  const [showGrammarBrowseLanguageModal, setShowGrammarBrowseLanguageModal] = useState(false);
  const [showGrammarFilterModal, setShowGrammarFilterModal] = useState<string | null>(null);
  // Smart Add Word / Grammar state
  const [showSmartAdd, setShowSmartAdd] = useState(false);
  const [grammarFormLanguage, setGrammarFormLanguage] = useState<string | null>(null);
  // Translation state
  const [translationMode, setTranslationMode] = useState<"new" | "resume" | null>(null);
  const [hasTranslationHistory, setHasTranslationHistory] = useState(false);
  // Speaking & Writing state
  const [speakingWritingMode, setSpeakingWritingMode] = useState<"new" | "resume" | null>(null);
  const [hasSWSession, setHasSWSession] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);

  // Fetch pinyin map when a quiz starts or browsing begins
  const activeLang = activeQuiz?.language ?? browsingLanguage ?? flaggedReviewLanguage;
  useEffect(() => {
    if (activeLang) {
      getTransliterationMap(activeLang)
        .then(setPinyinMap)
        .catch(() => setPinyinMap({}));
    } else {
      setPinyinMap({});
    }
  }, [activeLang]);

  // Check for translation history on mount
  useEffect(() => {
    getTranslationHistory(1, 1)
      .then(({ total }) => setHasTranslationHistory(total > 0))
      .catch(() => {});
  }, [translationMode]);

  // Check for speaking/writing sessions (keyed by ISO code, not filename)
  useEffect(() => {
    (async () => {
      try {
        for (const code of ["en", "ja", "ko", "zh"]) {
          const sess = await getSpeakingWritingSession(code);
          if (sess && sess.corrections.length > 0) {
            setHasSWSession(true);
            return;
          }
        }
        setHasSWSession(false);
      } catch {
        setHasSWSession(false);
      }
    })();
  }, [speakingWritingMode]);

  async function handleLanguageSelected(language: string) {
    setShowLanguageModal(false);
    setSelectedLanguage(language);
    // Auto-skip level selection if language has no levels
    const { levels } = await getFilters(language);
    if (levels.length === 0) {
      setSelectedLevels([]);
    }
  }

  function handleLevelsSelected(levels: string[]) {
    setSelectedLevels(levels);
  }

  function handleLevelBack() {
    setSelectedLanguage(null);
    setShowLanguageModal(true);
  }

  async function handleFiltersSelected(filters: { topics: string[]; categories: string[] }) {
    if (starting || !selectedLanguage || !selectedLevels) return;
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
        levels: selectedLevels,
      });
      setSelectedLanguage(null);
      setSelectedLevels(null);
      setActiveQuiz(session);
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
      setSelectedLevels(null);
      setStarting(false);
    }
  }

  async function handleStartNew() {
    if (!selectedLanguage || !selectedLevels || !pendingFilters) return;
    const lang = selectedLanguage;
    const levels = selectedLevels;
    const filters = pendingFilters;
    // Clear all modal state immediately to prevent filter modal flash
    setResumePrompt(null);
    setSelectedLanguage(null);
    setSelectedLevels(null);
    setPendingFilters(null);
    try {
      const session = await startQuiz({
        language: lang,
        topics: filters.topics,
        categories: filters.categories,
        levels,
      });
      setActiveQuiz(session);
    } catch (err) {
      console.error("Failed to start quiz:", err);
      alert(String(err));
    } finally {
      setStarting(false);
    }
  }

  function handleFilterBack() {
    setSelectedLevels(null);
  }

  function handleFilterClose() {
    setSelectedLanguage(null);
    setSelectedLevels(null);
  }

  function handleQuizComplete() {
    setActiveQuiz(null);
  }

  function goHome() {
    setActiveQuiz(null);
    setBrowsingLanguage(null);
    setFlaggedReviewLanguage(null);
    setShowLanguageModal(false);
    setShowBrowseLanguageModal(false);
    setShowFlaggedLanguageModal(false);
    setSelectedLanguage(null);
    setSelectedLevels(null);
    setResumePrompt(null);
    setPendingFilters(null);
    setStarting(false);
    setActiveGrammarQuiz(null);
    setBrowsingGrammarLanguage(null);
    setShowGrammarLanguageModal(false);
    setShowGrammarBrowseLanguageModal(false);
    setShowGrammarFilterModal(null);
    setShowSmartAdd(false);
    setGrammarFormLanguage(null);
    setTranslationMode(null);
    setSpeakingWritingMode(null);
    setShowMetrics(false);
  }

  function handleAddWord() {
    setShowSmartAdd(true);
  }

  function handleAddGrammar() {
    setGrammarFormLanguage("open");
  }

  async function handleStartQuiz() {
    try {
      const languages = await fetchJson<{ filename: string; language: string }[]>("/api/languages/");
      if (languages.length === 1) {
        handleLanguageSelected(languages[0].filename.replace(/\.json$/, ""));
      } else {
        setShowLanguageModal(true);
      }
    } catch {
      setShowLanguageModal(true);
    }
  }

  async function handleFlaggedReview() {
    try {
      const languages = await fetchJson<{ filename: string; language: string }[]>("/api/languages/");
      if (languages.length === 1) {
        setFlaggedReviewLanguage(languages[0].filename.replace(/\.json$/, ""));
      } else {
        setShowFlaggedLanguageModal(true);
      }
    } catch {
      setShowFlaggedLanguageModal(true);
    }
  }

  async function handleBrowse() {
    try {
      const languages = await fetchJson<{ filename: string; language: string }[]>("/api/languages/");
      if (languages.length === 1) {
        setBrowsingLanguage(languages[0].filename.replace(/\.json$/, ""));
      } else {
        setShowBrowseLanguageModal(true);
      }
    } catch {
      setShowBrowseLanguageModal(true);
    }
  }

  async function handleStartGrammarQuiz() {
    try {
      const languages = await fetchJson<{ filename: string; language: string }[]>("/api/languages/");
      if (languages.length === 1) {
        const lang = languages[0].filename.replace(/\.json$/, "");
        setShowGrammarFilterModal(lang);
      } else {
        setShowGrammarLanguageModal(true);
      }
    } catch {
      setShowGrammarLanguageModal(true);
    }
  }

  async function handleGrammarFiltersSelected(filters: { chapters: number[]; subchapters: string[]; displayLanguage: string; quizMode: string }) {
    const lang = showGrammarFilterModal;
    if (!lang) return;
    setShowGrammarFilterModal(null);
    try {
      // Check for existing in-progress session
      const existing = await getCurrentGrammarSession(lang);
      if (existing && existing.status === "in-progress") {
        setActiveGrammarQuiz(existing);
        return;
      }
      const session = await startGrammarQuiz({
        language: lang,
        chapters: filters.chapters.length > 0 ? filters.chapters : undefined,
        subchapters: filters.subchapters.length > 0 ? filters.subchapters : undefined,
        displayLanguage: filters.displayLanguage,
        quizMode: filters.quizMode,
      });
      setActiveGrammarQuiz(session);
    } catch (err) {
      console.error("Failed to start grammar quiz:", err);
      alert(String(err));
    }
  }

  async function handleBrowseGrammar() {
    try {
      const languages = await fetchJson<{ filename: string; language: string }[]>("/api/languages/");
      if (languages.length === 1) {
        setBrowsingGrammarLanguage(languages[0].filename.replace(/\.json$/, ""));
      } else {
        setShowGrammarBrowseLanguageModal(true);
      }
    } catch {
      setShowGrammarBrowseLanguageModal(true);
    }
  }

  const showBackButton = !!(activeQuiz || browsingLanguage || flaggedReviewLanguage || showLanguageModal || selectedLanguage || showBrowseLanguageModal || showFlaggedLanguageModal || activeGrammarQuiz || browsingGrammarLanguage || showGrammarLanguageModal || showGrammarBrowseLanguageModal || showGrammarFilterModal || showSmartAdd || grammarFormLanguage || translationMode || speakingWritingMode || showMetrics);

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
                onClick={() => setLanguage(lang as typeof language)}
                className={`px-2 py-1 text-xs font-medium ${
                  language === lang
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
          {showBackButton && (
            <button
              onClick={goHome}
              className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
            >
              {t("back")}
            </button>
          )}
        </div>
      </header>
      {showSettingsModal && (
        <SettingsModal onClose={() => setShowSettingsModal(false)} />
      )}
      {showGrammarLanguageModal && (
        <LanguageSelectModal
          onSelect={(lang) => {
            setShowGrammarLanguageModal(false);
            setShowGrammarFilterModal(lang);
          }}
          onClose={() => setShowGrammarLanguageModal(false)}
        />
      )}
      {showGrammarBrowseLanguageModal && (
        <LanguageSelectModal
          onSelect={(lang) => {
            setShowGrammarBrowseLanguageModal(false);
            setBrowsingGrammarLanguage(lang);
          }}
          onClose={() => setShowGrammarBrowseLanguageModal(false)}
        />
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
        />
      )}
      {grammarFormLanguage && (
        <GrammarFormModal
          onSave={() => setGrammarFormLanguage(null)}
          onClose={() => setGrammarFormLanguage(null)}
        />
      )}
      {showBrowseLanguageModal && (
        <LanguageSelectModal
          onSelect={(lang) => {
            setShowBrowseLanguageModal(false);
            setBrowsingLanguage(lang);
          }}
          onClose={() => setShowBrowseLanguageModal(false)}
        />
      )}
      {showFlaggedLanguageModal && (
        <LanguageSelectModal
          onSelect={(lang) => {
            setShowFlaggedLanguageModal(false);
            setFlaggedReviewLanguage(lang);
          }}
          onClose={() => setShowFlaggedLanguageModal(false)}
        />
      )}
      {showLanguageModal && (
        <LanguageSelectModal
          onSelect={handleLanguageSelected}
          onClose={() => setShowLanguageModal(false)}
        />
      )}
      {selectedLanguage && !selectedLevels && !showLanguageModal && !resumePrompt && (
        <LevelSelectModal
          language={selectedLanguage}
          onSelect={handleLevelsSelected}
          onBack={handleLevelBack}
          onClose={handleFilterClose}
        />
      )}
      {selectedLanguage && selectedLevels && !showLanguageModal && !resumePrompt && (
        <QuizFilterModal
          language={selectedLanguage}
          onStart={handleFiltersSelected}
          onBack={handleFilterBack}
          onClose={handleFilterClose}
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
      <main className="flex-1">
        {activeGrammarQuiz ? (
          <GrammarQuizTaking
            session={activeGrammarQuiz}
            onComplete={() => setActiveGrammarQuiz(null)}
            onStartNew={handleStartGrammarQuiz}
          />
        ) : browsingGrammarLanguage ? (
          <GrammarList
            language={browsingGrammarLanguage}
            onBack={() => setBrowsingGrammarLanguage(null)}
          />
        ) : activeQuiz ? (
          <QuizTaking
            session={activeQuiz}
            onComplete={handleQuizComplete}
            onBrowse={handleBrowse}
            onStartNew={handleStartQuiz}
            transliterationMap={transliterationMap}
          />
        ) : flaggedReviewLanguage ? (
          <FlaggedReview
            language={flaggedReviewLanguage}
            onBack={() => setFlaggedReviewLanguage(null)}
            transliterationMap={transliterationMap}
          />
        ) : browsingLanguage ? (
          <WordList
            language={browsingLanguage}
            onBack={() => setBrowsingLanguage(null)}
            transliterationMap={transliterationMap}
          />
        ) : translationMode ? (
          <TranslationView mode={translationMode} />
        ) : speakingWritingMode ? (
          <SpeakingWritingView mode={speakingWritingMode} />
        ) : showMetrics ? (
          <MetricsView />
        ) : (
          <EmptyState
            onResume={(session) => setActiveQuiz(session)}
            onResumeGrammar={(session) => setActiveGrammarQuiz(session)}
            onStartNew={handleStartQuiz}
            onBrowse={handleBrowse}
            onFlaggedReview={handleFlaggedReview}
            onGrammarQuiz={handleStartGrammarQuiz}
            onBrowseGrammar={handleBrowseGrammar}
            onAddWord={handleAddWord}
            onAddGrammar={handleAddGrammar}
            onStartTranslation={() => setTranslationMode("new")}
            onResumeTranslation={() => setTranslationMode("resume")}
            hasTranslationHistory={hasTranslationHistory}
            onStartSpeakingWriting={() => setSpeakingWritingMode("new")}
            onResumeSpeakingWriting={() => setSpeakingWritingMode("resume")}
            hasSWSession={hasSWSession}
            onOpenMetrics={() => setShowMetrics(true)}
          />
        )}
      </main>
    </div>
  );
}
