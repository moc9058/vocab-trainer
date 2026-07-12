import { useState } from "react";
import { useI18n } from "../i18n/context";
import WordList from "./WordList";
import GrammarList from "./GrammarList";
import type { useWordQueue } from "../hooks/useWordQueue";
import type { useGrammarQueue } from "../hooks/useGrammarQueue";

type WordEnqueue = ReturnType<typeof useWordQueue>["enqueue"];
type WordEnqueueUpdate = ReturnType<typeof useWordQueue>["enqueueUpdate"];
type GrammarEnqueue = ReturnType<typeof useGrammarQueue>["enqueue"];
type GrammarEnqueueUpdate = ReturnType<typeof useGrammarQueue>["enqueueUpdate"];

interface Props {
  language: string;
  initialTab: "word" | "grammar";
  onTabChange: (tab: "word" | "grammar") => void;
  onBack: () => void;
  initialExpandId?: string;
  initialSearch?: string;
  refreshSignal: number;
  grammarRefreshSignal: number;
  onQueue: WordEnqueue;
  onQueueEdit: WordEnqueueUpdate;
  onGrammarQueue: GrammarEnqueue;
  onGrammarUpdateQueue: GrammarEnqueueUpdate;
  pendingTerms: Set<string>;
  succeededTerms: Set<string>;
  pendingDraftIds: Set<string>;
  grammarPendingTerms: Set<string>;
  grammarPendingDraftIds: Set<string>;
}

export default function BrowseView({
  language,
  initialTab,
  onTabChange,
  onBack,
  initialExpandId,
  initialSearch,
  refreshSignal,
  grammarRefreshSignal,
  onQueue,
  onQueueEdit,
  onGrammarQueue,
  onGrammarUpdateQueue,
  pendingTerms,
  succeededTerms,
  pendingDraftIds,
  grammarPendingTerms,
  grammarPendingDraftIds,
}: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"word" | "grammar">(initialTab);

  function selectTab(next: "word" | "grammar") {
    if (next === tab) return;
    setTab(next);
    onTabChange(next);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-gray-700 bg-gray-800 px-3 sm:px-6 pt-3">
        <button
          onClick={() => selectTab("word")}
          className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
            tab === "word" ? "bg-gray-900 text-blue-400" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("sectionVocabulary")}
        </button>
        <button
          onClick={() => selectTab("grammar")}
          className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
            tab === "grammar" ? "bg-gray-900 text-emerald-400" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("sectionGrammar")}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "word" ? (
          <WordList
            language={language}
            onBack={onBack}
            initialExpandId={initialExpandId}
            initialSearch={initialSearch}
            refreshSignal={refreshSignal}
            onQueue={onQueue}
            onQueueEdit={onQueueEdit}
            pendingTerms={pendingTerms}
            succeededTerms={succeededTerms}
            pendingDraftIds={pendingDraftIds}
          />
        ) : (
          <GrammarList
            language={language}
            onBack={onBack}
            onQueue={onQueue}
            onGrammarQueue={onGrammarQueue}
            onGrammarUpdateQueue={onGrammarUpdateQueue}
            pendingTerms={pendingTerms}
            succeededTerms={succeededTerms}
            grammarPendingTerms={grammarPendingTerms}
            grammarPendingDraftIds={grammarPendingDraftIds}
            refreshSignal={refreshSignal + grammarRefreshSignal}
          />
        )}
      </div>
    </div>
  );
}
