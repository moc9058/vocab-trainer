import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { getCurrentSession, startQuiz } from "../api/quiz";
import { getTransliterationMap } from "../api/vocab";
import EmptyState from "./EmptyState";
import QuizTaking from "./QuizTaking";
import WordList from "./WordList";
import LanguageSelectModal from "./LanguageSelectModal";
import QuizFilterModal from "./QuizFilterModal";
import type { QuizSession } from "../types";

export default function Dashboard() {
  const { t } = useI18n();
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [showLanguageModal, setShowLanguageModal] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [resumePrompt, setResumePrompt] = useState<QuizSession | null>(null);
  const [pendingFilters, setPendingFilters] = useState<{
    topics: string[];
    categories: string[];
    levels: string[];
  } | null>(null);
  const [browsingLanguage, setBrowsingLanguage] = useState<string | null>(null);
  const [showBrowseLanguageModal, setShowBrowseLanguageModal] = useState(false);
  const [transliterationMap, setPinyinMap] = useState<Record<string, string>>({});

  // Fetch pinyin map when a quiz starts or browsing begins
  const activeLang = activeQuiz?.language ?? browsingLanguage;
  useEffect(() => {
    if (activeLang) {
      getTransliterationMap(activeLang)
        .then(setPinyinMap)
        .catch(() => setPinyinMap({}));
    } else {
      setPinyinMap({});
    }
  }, [activeLang]);

  // Re-fetch pinyin map every 30s to pick up newly generated words
  useEffect(() => {
    if (!activeLang) return;
    const id = setInterval(() => {
      getTransliterationMap(activeLang)
        .then(setPinyinMap)
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, [activeLang]);

  function handleLanguageSelected(language: string) {
    setShowLanguageModal(false);
    setSelectedLanguage(language);
  }

  async function handleFiltersSelected(filters: { topics: string[]; categories: string[]; levels: string[] }) {
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
      });
      setSelectedLanguage(null);
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
      setStarting(false);
    }
  }

  async function handleStartNew() {
    if (!selectedLanguage || !pendingFilters) return;
    const lang = selectedLanguage;
    const filters = pendingFilters;
    // Clear all modal state immediately to prevent filter modal flash
    setResumePrompt(null);
    setSelectedLanguage(null);
    setPendingFilters(null);
    try {
      const session = await startQuiz({
        language: lang,
        topics: filters.topics,
        categories: filters.categories,
        levels: filters.levels,
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
    setSelectedLanguage(null);
    setShowLanguageModal(true);
  }

  function handleFilterClose() {
    setSelectedLanguage(null);
  }

  function handleQuizComplete() {
    setActiveQuiz(null);
  }

  function goHome() {
    setActiveQuiz(null);
    setBrowsingLanguage(null);
    setShowLanguageModal(false);
    setShowBrowseLanguageModal(false);
    setSelectedLanguage(null);
    setResumePrompt(null);
    setPendingFilters(null);
    setStarting(false);
  }

  const showBackButton = !!(activeQuiz || browsingLanguage || showLanguageModal || selectedLanguage || showBrowseLanguageModal);

  return (
    <div className="flex min-h-screen flex-col bg-gray-900">
      <header className="flex items-center justify-between border-b border-gray-700 bg-gray-800 px-3 sm:px-6 py-3">
        <h1 className="text-base sm:text-xl font-bold text-gray-100">{t("appTitle")}</h1>
        {showBackButton && (
          <button
            onClick={goHome}
            className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("back")}
          </button>
        )}
      </header>
      {showBrowseLanguageModal && (
        <LanguageSelectModal
          onSelect={(lang) => {
            setShowBrowseLanguageModal(false);
            setBrowsingLanguage(lang);
          }}
          onClose={() => setShowBrowseLanguageModal(false)}
        />
      )}
      {showLanguageModal && (
        <LanguageSelectModal
          onSelect={handleLanguageSelected}
          onClose={() => setShowLanguageModal(false)}
        />
      )}
      {selectedLanguage && !showLanguageModal && !resumePrompt && (
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
        {activeQuiz ? (
          <QuizTaking
            session={activeQuiz}
            onComplete={handleQuizComplete}
            onBrowse={() => setShowBrowseLanguageModal(true)}
            onStartNew={() => setShowLanguageModal(true)}
            transliterationMap={transliterationMap}
          />
        ) : browsingLanguage ? (
          <WordList
            language={browsingLanguage}
            onBack={() => setBrowsingLanguage(null)}
            transliterationMap={transliterationMap}
          />
        ) : (
          <EmptyState
            onResume={(session) => setActiveQuiz(session)}
            onStartNew={() => setShowLanguageModal(true)}
            onBrowse={() => setShowBrowseLanguageModal(true)}
          />
        )}
      </main>
    </div>
  );
}
