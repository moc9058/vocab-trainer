import { useState } from "react";
import { useI18n } from "../i18n/context";
import { getCurrentSession, startQuiz } from "../api/quiz";
import EmptyState from "./EmptyState";
import QuizTaking from "./QuizTaking";
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
    setResumePrompt(null);
    try {
      const session = await startQuiz({
        language: selectedLanguage,
        topics: pendingFilters.topics,
        categories: pendingFilters.categories,
        levels: pendingFilters.levels,
      });
      setSelectedLanguage(null);
      setPendingFilters(null);
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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
        <h1 className="text-xl font-bold text-gray-800">{t("appTitle")}</h1>
        <button
          onClick={() => setShowLanguageModal(true)}
          disabled={starting}
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {t("startQuiz")}
        </button>
      </header>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-lg">
            <p className="mb-4 text-gray-700">{t("existingQuizFound")}</p>
            <div className="flex gap-3">
              <button
                onClick={handleResume}
                className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
              >
                {t("resumeQuiz")}
              </button>
              <button
                onClick={handleStartNew}
                className="flex-1 rounded-lg bg-gray-200 px-4 py-2 text-gray-700 hover:bg-gray-300"
              >
                {t("startNewQuiz")}
              </button>
            </div>
          </div>
        </div>
      )}
      <main className="flex-1">
        {activeQuiz ? (
          <QuizTaking session={activeQuiz} onComplete={handleQuizComplete} />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}
