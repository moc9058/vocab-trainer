import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import ImportDestinationRail from "./ImportDestinationRail";
import ImportSentenceCard from "./ImportSentenceCard";
import {
  flattenSentences,
  sentenceCoverage,
  sentenceItems,
  sessionCounts,
} from "../../utils/importSession";
import { useImportLibraryStatus } from "../../hooks/useImportLibraryStatus";
import type { ImportItem, ImportSession } from "../../types";
import type { SaveStatus } from "../../hooks/useImportSession";

const TRANSLATION_PREF_KEY = "importShowTranslations";

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
  /** How many characters each sentence still leaves unaccounted for. Computed once
   *  per items change — a collapsed row would otherwise rescan on every render. */
  const gapsBySentence = useMemo(() => {
    const map = new Map<number, number>();
    for (const s of sentences) {
      const { words } = sentenceItems(session.items, s.index);
      map.set(s.index, sentenceCoverage(s.text, words).missing);
    }
    return map;
  }, [sentences, session.items]);
  const focused = session.focusedSentenceIndex;
  const focusRef = useRef<HTMLDivElement>(null);

  // Reading preference, not session data — kept in localStorage so it survives
  // moving between articles.
  const [showTranslations, setShowTranslations] = useState(
    () => localStorage.getItem(TRANSLATION_PREF_KEY) !== "0"
  );
  function toggleTranslations() {
    setShowTranslations((prev) => {
      localStorage.setItem(TRANSLATION_PREF_KEY, prev ? "0" : "1");
      return !prev;
    });
  }

  const { inLibrary, groupBByTerm } = useImportLibraryStatus(
    session.id,
    session.language,
    session.items
  );

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
    // `overflow-x-hidden` is a hard stop: nothing in a review should ever be able
    // to scroll the page sideways on a phone.
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-5xl px-3 pb-2 pt-4 sm:p-6">
        <header className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-gray-100 sm:text-lg">
              {t("importReview")}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="font-mono text-[11px] text-gray-500">
                {counts.registered}/{counts.total} {t("importRegistered")}
              </span>
              <SaveIndicator
                status={saveStatus}
                error={saveError}
                updatedAt={session.updatedAt}
                onRetry={onRetrySave}
              />
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-2">
            <button
              onClick={toggleTranslations}
              aria-pressed={showTranslations}
              className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs ${
                showTranslations
                  ? "border-indigo-600/70 bg-indigo-950/40 text-indigo-200"
                  : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"
              }`}
            >
              {showTranslations ? t("importHideTranslation") : t("importShowTranslation")}
            </button>
            <button
              onClick={onExit}
              className="whitespace-nowrap rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-gray-500 hover:text-gray-200 sm:text-sm"
            >
              {t("importBackToSessions")}
            </button>
          </div>
        </header>

        {/* Grid placement is explicit so the destination can lead on a phone —
            where it is unreachable at the bottom — and still be the right-hand
            sidebar from `lg`. */}
        <div className="grid gap-4 lg:grid-cols-[1fr_19rem] lg:gap-5">
          <div className="lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4 lg:self-start">
            <ImportDestinationRail
              language={session.language}
              wordGroupId={session.wordGroupId}
              grammarGroupId={session.grammarGroupId}
              groupBNames={session.groupBNames}
              onChange={(patch) => onPatch((s) => ({ ...s, ...patch }), true)}
              collapsible
            />
            <p className="mt-2 hidden px-1 text-[11px] leading-snug text-gray-600 lg:block">
              {t("importDestinationAppliesToNext")}
            </p>
          </div>

          {/* The article, with the focused sentence opened into its editor. */}
          <div className="space-y-5 lg:col-start-1 lg:row-start-1 lg:space-y-6">
            {session.paragraphs.map((paragraph, pIndex) => (
              <section key={pIndex} className="sm:flex sm:gap-3">
                {/* The number is a gutter column from `sm`; on a phone it sits above
                    the paragraph instead, which buys back ~50px of text width. */}
                <span className="mb-1 block font-mono text-[11px] text-gray-600 sm:mb-0 sm:w-6 sm:shrink-0 sm:pt-1 sm:text-right">
                  {String(pIndex + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 space-y-1.5 border-l border-gray-800 pl-2.5 sm:flex-1 sm:space-y-2 sm:pl-4">
                  {paragraph.sentences.map((sentence) => {
                    const isFocused = sentence.index === focused;
                    const { words, grammar } = sentenceItems(session.items, sentence.index);
                    if (isFocused) {
                      return (
                        <div
                          key={sentence.index}
                          ref={focusRef}
                          className="scroll-mt-4 scroll-mb-24 lg:scroll-mb-4"
                        >
                          <ImportSentenceCard
                            language={session.language}
                            sentence={sentence}
                            items={session.items}
                            onSetItems={onSetItems}
                            onPatchItem={onPatchItem}
                            onRegister={onRegister}
                            showTranslation={showTranslations}
                            inLibrary={inLibrary}
                            groupBByTerm={groupBByTerm}
                          />
                          {/* On a phone the same controls live in the sticky bar below. */}
                          <div className="mt-2 hidden items-center gap-3 text-xs lg:flex">
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
                    const gap = gapsBySentence.get(sentence.index) ?? 0;
                    return (
                      <button
                        key={sentence.index}
                        onClick={() => focus(sentence.index)}
                        className="block w-full rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-gray-800/60"
                      >
                        {/* Two lines on a phone: one ellipsized line is too little to
                            tell sentences apart when picking the next one. */}
                        <p
                          className={`line-clamp-2 break-words text-[15px] leading-relaxed sm:line-clamp-1 ${
                            total > 0 ? "text-gray-300" : "text-gray-600"
                          }`}
                        >
                          {sentence.text}
                        </p>
                        {showTranslations && sentence.translation?.trim() && (
                          <p className="mt-0.5 line-clamp-2 break-words text-[13px] leading-snug text-indigo-200/50 sm:line-clamp-1">
                            {sentence.translation}
                          </p>
                        )}
                        {(total > 0 || gap > 0) && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {/* Leads the chips: an incomplete sentence is the reason
                                to open this row at all. */}
                            {gap > 0 && (
                              <span className="rounded border border-amber-700/60 px-1.5 py-0.5 text-[10px] text-amber-400/90">
                                {gap}
                                {t("importCoverageMissing")}
                              </span>
                            )}
                            {words.map((w) => (
                              <StatusChip
                                key={w.id}
                                status={w.status}
                                label={w.term}
                                kind="word"
                                inGroupA={inLibrary.has(w.term.trim())}
                              />
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
        </div>

        {/* Sentence navigation, pinned on a phone: the focused card is taller than
            the viewport, so inline controls scroll out of reach while editing. */}
        <div className="sticky bottom-0 z-20 -mx-3 mt-3 flex items-center gap-2 border-t border-gray-800 bg-gray-900/95 px-3 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden">
          <button
            onClick={() => step(-1)}
            disabled={position <= 0}
            className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 disabled:opacity-30"
          >
            ◀ {t("importPrevSentence")}
          </button>
          <span className="mx-auto font-mono text-xs text-gray-500">
            {position + 1} / {sentences.length}
          </span>
          <button
            onClick={() => step(1)}
            disabled={position >= sentences.length - 1}
            className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 disabled:opacity-30"
          >
            {t("importNextSentence")} ▶
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusChip({
  status,
  label,
  kind,
  inGroupA = false,
}: {
  status: ImportItem["status"];
  label: string;
  kind: "word" | "grammar";
  /** Already in a Group A study set — kept visible rather than greyed out like a
   *  plain "done" chip, since it is the state the reader is scanning for. */
  inGroupA?: boolean;
}) {
  const done = status === "registered" || status === "duplicate";
  const base = kind === "word" ? "border-blue-800/60 text-blue-300" : "border-emerald-800/60 text-emerald-300";
  const tone =
    status === "failed"
      ? "border-red-800/60 text-red-300"
      : status === "queued"
      ? "border-amber-800/60 text-amber-300"
      : inGroupA
      ? "border-emerald-500/70 bg-emerald-900/40 font-medium text-emerald-300"
      : done
      ? "border-gray-700 text-gray-500"
      : base;
  // `max-w-full truncate` matters: a grammar statement is long enough to make an
  // unbreakable chip wider than a phone, which used to drag the whole page sideways.
  return (
    <span className={`inline-block max-w-full truncate rounded border px-1.5 py-0.5 align-middle text-[10px] ${tone}`}>
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
