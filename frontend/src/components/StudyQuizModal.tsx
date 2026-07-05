import { useState } from "react";
import { useI18n } from "../i18n/context";
import QuizFilterModal, { type QuizFilters } from "./QuizFilterModal";
import GrammarFilterModal from "./GrammarFilterModal";

interface Props {
  language: string;
  initialTab: "word" | "grammar";
  onClose: () => void;
  onStartWord: (filters: QuizFilters) => void;
  onPrintWord?: (filters: QuizFilters, count: number | null) => void;
  onStartGrammar: (filters: { groupIds: string[] }) => void;
}

export default function StudyQuizModal({
  language,
  initialTab,
  onClose,
  onStartWord,
  onPrintWord,
  onStartGrammar,
}: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"word" | "grammar">(initialTab);

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
      </div>
      {tab === "word" ? (
        <QuizFilterModal
          language={language}
          onStart={onStartWord}
          onClose={onClose}
          onPrint={onPrintWord}
          showFlaggedScope
        />
      ) : (
        <GrammarFilterModal
          language={language}
          onStart={onStartGrammar}
          onClose={onClose}
        />
      )}
    </>
  );
}
