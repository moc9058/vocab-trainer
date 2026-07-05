import { useState } from "react";
import { useI18n } from "../i18n/context";
import QuizFilterModal, { type QuizFilters } from "./QuizFilterModal";
import GrammarFilterModal from "./GrammarFilterModal";
import CombinedQuizFilterModal, { type CombinedQuizFilters } from "./CombinedQuizFilterModal";

export type StudyQuizTab = "word" | "grammar" | "combined";

interface Props {
  language: string;
  initialTab: StudyQuizTab;
  onClose: () => void;
  onStartWord: (filters: QuizFilters) => void;
  onPrintWord?: (filters: QuizFilters, count: number | null) => void;
  onStartGrammar: (filters: { groupIds: string[] }) => void;
  onStartCombined: (filters: CombinedQuizFilters) => void;
}

export default function StudyQuizModal({
  language,
  initialTab,
  onClose,
  onStartWord,
  onPrintWord,
  onStartGrammar,
  onStartCombined,
}: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<StudyQuizTab>(initialTab);

  return (
    <>
      <div className="fixed left-1/2 top-4 z-[60] flex -translate-x-1/2 gap-1 rounded-lg border border-gray-700 bg-gray-900/95 p-1 shadow-lg">
        <button
          onClick={() => setTab("word")}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === "word" ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("sectionVocabulary")}
        </button>
        <button
          onClick={() => setTab("grammar")}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === "grammar" ? "bg-emerald-600 text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("sectionGrammar")}
        </button>
        <button
          onClick={() => setTab("combined")}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === "combined" ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("combinedQuiz")}
        </button>
      </div>
      {tab === "word" ? (
        <QuizFilterModal
          language={language}
          onStart={onStartWord}
          onClose={onClose}
          onPrint={onPrintWord}
          showFlaggedScope
        />
      ) : tab === "grammar" ? (
        <GrammarFilterModal
          language={language}
          onStart={onStartGrammar}
          onClose={onClose}
        />
      ) : (
        <CombinedQuizFilterModal
          language={language}
          onStart={onStartCombined}
          onClose={onClose}
        />
      )}
    </>
  );
}
