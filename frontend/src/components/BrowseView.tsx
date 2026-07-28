import { useState } from "react";
import { useI18n } from "../i18n/context";
import WordList from "./WordList";
import GrammarList from "./GrammarList";
import ImportView from "./ImportView";
import type { useWordQueue } from "../hooks/useWordQueue";
import type { useGrammarQueue } from "../hooks/useGrammarQueue";

type WordEnqueue = ReturnType<typeof useWordQueue>["enqueue"];
type WordEnqueueUpdate = ReturnType<typeof useWordQueue>["enqueueUpdate"];
type GrammarEnqueue = ReturnType<typeof useGrammarQueue>["enqueue"];
type GrammarEnqueueUpdate = ReturnType<typeof useGrammarQueue>["enqueueUpdate"];

export type BrowseTab = "word" | "grammar" | "import";

interface Props {
  language: string;
  initialTab: BrowseTab;
  onTabChange: (tab: BrowseTab) => void;
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
  const [tab, setTab] = useState<BrowseTab>(initialTab);

  function selectTab(next: BrowseTab) {
    if (next === tab) return;
    setTab(next);
    onTabChange(next);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-gray-700 bg-gray-800 px-3 sm:px-6 pt-3">
        <button
          onClick={() => selectTab("word")}
          className={`shrink-0 rounded-t-lg px-3 py-2 text-sm font-medium transition-colors sm:px-4 ${
            tab === "word" ? "bg-gray-900 text-blue-400" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("sectionVocabulary")}
        </button>
        <button
          onClick={() => selectTab("grammar")}
          className={`shrink-0 rounded-t-lg px-3 py-2 text-sm font-medium transition-colors sm:px-4 ${
            tab === "grammar" ? "bg-gray-900 text-emerald-400" : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("sectionGrammar")}
        </button>
        {/* Set apart from the two reading tabs: this is where new material enters,
            not another list to browse. The label is shortened on a phone — with the
            two tabs beside it the full one pushes the bar past a 375px viewport. */}
        <button
          onClick={() => selectTab("import")}
          className={`ml-auto mb-1 shrink-0 self-center whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
            tab === "import"
              ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
              : "border-gray-600 text-gray-400 hover:border-indigo-500/60 hover:text-indigo-300"
          }`}
        >
          ＋ <span className="sm:hidden">{t("importFromSourceShort")}</span>
          <span className="hidden sm:inline">{t("importFromSource")}</span>
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "import" ? (
          <ImportView language={language} onQueue={onQueue} onGrammarQueue={onGrammarQueue} />
        ) : tab === "word" ? (
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
