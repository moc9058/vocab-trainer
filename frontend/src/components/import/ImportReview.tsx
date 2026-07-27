import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../i18n/context";
import ImportDestinationRail from "./ImportDestinationRail";
import ImportSentenceCard from "./ImportSentenceCard";
import { flattenSentences, sentenceItems, sessionCounts } from "../../utils/importSession";
import type { ImportItem, ImportSession } from "../../types";
import type { SaveStatus } from "../../hooks/useImportSession";

interface Props {
  session: ImportSession;
  saveStatus: SaveStatus;
  saveError: string | null;
  onRetrySave: () => void;
  onPatch: (updater: (s: ImportSession) => ImportSession, immediate?: boolean) => void;
  onSetItems: (updater: (items: ImportItem[]) => ImportItem[], immediate?: boolean) => void;
  onPatchItem: (id: string, updates: Partial<ImportItem>, immediate?: boolean) => void;
  onRegister: (id: string) => void;
  onExit: () => void;
}

export default function ImportReview({
  session,
  saveStatus,
  saveError,
  onRetrySave,
  onPatch,
  onSetItems,
  onPatchItem,
  onRegister,
  onExit,
}: Props) {
  const { t } = useI18n();
  const sentences = useMemo(() => flattenSentences(session.paragraphs), [session.paragraphs]);
  const counts = useMemo(() => sessionCounts(session.items), [session.items]);
  const focused = session.focusedSentenceIndex;
  const focusRef = useRef<HTMLDivElement>(null);

  const position = sentences.findIndex((s) => s.index === focused);

  function focus(index: number) {
    onPatch((s) => ({ ...s, focusedSentenceIndex: index }));
  }

  function step(delta: number) {
    const next = sentences[position + delta];
    if (next) focus(next.index);
  }

  // Keep the expanded card in view when moving with the prev/next controls.
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-lg font-bold text-gray-100">{t("importReview")}</h2>
          <span className="font-mono text-xs text-gray-500">
            {counts.registered}/{counts.total} {t("importRegistered")}
          </span>
          <SaveIndicator
            status={saveStatus}
            error={saveError}
            updatedAt={session.updatedAt}
            onRetry={onRetrySave}
          />
          <button onClick={onExit} className="ml-auto text-sm text-gray-400 hover:text-gray-200">
            {t("importBackToSessions")}
          </button>
        </header>

        <div className="grid gap-5 lg:grid-cols-[1fr_19rem]">
          {/* The article, with the focused sentence opened into its editor. */}
          <div className="space-y-6">
            {session.paragraphs.map((paragraph, pIndex) => (
              <section key={pIndex} className="flex gap-3">
                <span className="w-6 shrink-0 pt-1 text-right font-mono text-[11px] text-gray-600">
                  {String(pIndex + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1 space-y-2 border-l border-gray-800 pl-4">
                  {paragraph.sentences.map((sentence) => {
                    const isFocused = sentence.index === focused;
                    const { words, grammar } = sentenceItems(session.items, sentence.index);
                    if (isFocused) {
                      return (
                        <div key={sentence.index} ref={focusRef}>
                          <ImportSentenceCard
                            sentence={sentence}
                            items={session.items}
                            onSetItems={onSetItems}
                            onPatchItem={onPatchItem}
                            onRegister={onRegister}
                          />
                          <div className="mt-2 flex items-center gap-3 text-xs">
                            <button
                              onClick={() => step(-1)}
                              disabled={position <= 0}
                              className="text-gray-400 hover:text-gray-200 disabled:opacity-30"
                            >
                              ◀ {t("importPrevSentence")}
                            </button>
                            <span className="font-mono text-gray-600">
                              {position + 1} / {sentences.length}
                            </span>
                            <button
                              onClick={() => step(1)}
                              disabled={position >= sentences.length - 1}
                              className="text-gray-400 hover:text-gray-200 disabled:opacity-30"
                            >
                              {t("importNextSentence")} ▶
                            </button>
                          </div>
                        </div>
                      );
                    }
                    const total = words.length + grammar.length;
                    return (
                      <button
                        key={sentence.index}
                        onClick={() => focus(sentence.index)}
                        className="block w-full rounded-lg px-1 py-1 text-left transition-colors hover:bg-gray-800/60"
                      >
                        <p
                          className={`truncate text-[15px] leading-relaxed ${
                            total > 0 ? "text-gray-300" : "text-gray-600"
                          }`}
                        >
                          {sentence.text}
                        </p>
                        {total > 0 && (
                          <span className="mt-0.5 flex flex-wrap gap-1">
                            {words.map((w) => (
                              <StatusChip key={w.id} status={w.status} label={w.term} kind="word" />
                            ))}
                            {grammar.map((g) => (
                              <StatusChip
                                key={g.id}
                                status={g.status}
                                label={g.statement || "—"}
                                kind="grammar"
                              />
                            ))}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <div className="lg:sticky lg:top-4 lg:self-start">
            <ImportDestinationRail
              language={session.language}
              wordGroupId={session.wordGroupId}
              grammarGroupId={session.grammarGroupId}
              groupBNames={session.groupBNames}
              onChange={(patch) => onPatch((s) => ({ ...s, ...patch }), true)}
            />
            <p className="mt-2 px-1 text-[11px] leading-snug text-gray-600">
              {t("importDestinationAppliesToNext")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusChip({
  status,
  label,
  kind,
}: {
  status: ImportItem["status"];
  label: string;
  kind: "word" | "grammar";
}) {
  const done = status === "registered" || status === "duplicate";
  const base = kind === "word" ? "border-blue-800/60 text-blue-300" : "border-emerald-800/60 text-emerald-300";
  const tone =
    status === "failed"
      ? "border-red-800/60 text-red-300"
      : status === "queued"
      ? "border-amber-800/60 text-amber-300"
      : done
      ? "border-gray-700 text-gray-500"
      : base;
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${tone}`}>
      {done && "✓"}
      {status === "failed" && "✗"}
      {label}
    </span>
  );
}

function SaveIndicator({
  status,
  error,
  updatedAt,
  onRetry,
}: {
  status: SaveStatus;
  error: string | null;
  updatedAt: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  if (status === "saving") {
    return <span className="text-[11px] text-gray-500">{t("importSaving")}</span>;
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-[11px]">
        <span className="text-red-400" title={error ?? undefined}>{t("importSaveFailed")}</span>
        <button onClick={onRetry} className="text-gray-400 underline hover:text-gray-200">
          {t("importRetry")}
        </button>
      </span>
    );
  }
  return (
    <span className="text-[11px] text-gray-600">
      {t("importSaved")} {new Date(updatedAt).toLocaleTimeString()}
    </span>
  );
}
