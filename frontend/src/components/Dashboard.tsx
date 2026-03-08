import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getHistory, startQuiz } from "../api/quiz";
import Sidebar from "./Sidebar";
import SessionDetail from "./SessionDetail";
import EmptyState from "./EmptyState";
import QuizTaking from "./QuizTaking";
import LanguageSelectModal from "./LanguageSelectModal";
import QuizFilterModal from "./QuizFilterModal";
import type { QuizSession, QuizSessionSummary } from "../types";

export default function Dashboard() {
  const { t } = useI18n();
  const [history, setHistory] = useState<QuizSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeQuiz, setActiveQuiz] = useState<QuizSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [showLanguageModal, setShowLanguageModal] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);

  function refreshHistory() {
    getHistory()
      .then((data) => {
        setHistory(data);
        if (data.length > 0) {
          setSelectedId(data[0].sessionId);
        }
      })
      .catch(() => setHistory([]));
  }

  useEffect(() => {
    getHistory()
      .then((data) => {
        setHistory(data);
        if (data.length > 0) {
          setSelectedId(data[0].sessionId);
        }
      })
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, []);

  function handleLanguageSelected(language: string) {
    setShowLanguageModal(false);
    setSelectedLanguage(language);
  }

  async function handleFiltersSelected(filters: { topics: string[]; categories: string[] }) {
    if (starting || !selectedLanguage) return;
    setStarting(true);
    try {
      const session = await startQuiz({
        language: selectedLanguage,
        topics: filters.topics,
        categories: filters.categories,
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

  function handleFilterBack() {
    setSelectedLanguage(null);
    setShowLanguageModal(true);
  }

  function handleFilterClose() {
    setSelectedLanguage(null);
  }

  function handleQuizComplete() {
    setActiveQuiz(null);
    refreshHistory();
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
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
      {selectedLanguage && !showLanguageModal && (
        <QuizFilterModal
          language={selectedLanguage}
          onStart={handleFiltersSelected}
          onBack={handleFilterBack}
          onClose={handleFilterClose}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          history={history}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <main className="flex-1">
          {activeQuiz ? (
            <QuizTaking session={activeQuiz} onComplete={handleQuizComplete} />
          ) : history.length === 0 ? (
            <EmptyState />
          ) : selectedId ? (
            <SessionDetail sessionId={selectedId} />
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
    </div>
  );
}
