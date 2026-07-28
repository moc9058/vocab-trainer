import { useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import PinyinInput from "../PinyinInput";
import {
  addGrammarItem,
  addWordItem,
  coverageRuns,
  isLocked,
  mergeWordItems,
  sentenceCoverage,
  sentenceItems,
  sentenceSpanForTerms,
  splitWordItem,
  undoDerivation,
} from "../../utils/importSession";
import type {
  ImportGrammarItem,
  ImportItem,
  ImportSentence,
  ImportWordItem,
} from "../../types";

interface Props {
  /** Backend full-name language ("chinese"), which is what gates the pinyin input. */
  language: string;
  sentence: ImportSentence;
  /** The whole item list — `sourceIds` on a merged row point at tombstones in it. */
  items: ImportItem[];
  onSetItems: (updater: (items: ImportItem[]) => ImportItem[], immediate?: boolean) => void;
  onPatchItem: (id: string, updates: Partial<ImportItem>, immediate?: boolean) => void;
  onRegister: (id: string) => void;
  /** Sentence translation visibility is a per-user preference owned by `ImportReview`. */
  showTranslation: boolean;
  /** Terms already in the library (= in Group A), keyed by term so a word registered
   *  from one sentence lights up its other occurrences too. */
  inLibrary: Set<string>;
  /** Category-B group names already holding a term. */
  groupBByTerm: Map<string, string[]>;
}

export default function ImportSentenceCard({
  language,
  sentence,
  items,
  onSetItems,
  onPatchItem,
  onRegister,
  showTranslation,
  inLibrary,
  groupBByTerm,
}: Props) {
  const { t } = useI18n();
  const { words, grammar } = sentenceItems(items, sentence.index);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [splitting, setSplitting] = useState<{ id: string; draft: string } | null>(null);
  const [selection, setSelection] = useState("");
  const sentenceRef = useRef<HTMLParagraphElement>(null);

  const byId = new Map(items.map((i) => [i.id, i]));
  const mergeSelection = mergeIds.filter((id) => words.some((w) => w.id === id));

  /** Reads a selection only when it lies inside the sentence text itself — this
   *  also rejects text selected inside one of the row inputs. */
  function captureSelection() {
    const sel = window.getSelection();
    const node = sentenceRef.current;
    if (!sel || sel.isCollapsed || !node || sel.rangeCount === 0) {
      setSelection("");
      return;
    }
    const range = sel.getRangeAt(0);
    if (!node.contains(range.commonAncestorContainer)) {
      setSelection("");
      return;
    }
    const text = sel.toString().trim();
    setSelection(text.length > 0 && text.length <= 30 ? text : "");
  }

  function merge(ids: string[]) {
    if (ids.length < 2) return;
    onSetItems((prev) => mergeWordItems(prev, ids, sentence.text), true);
    setMergeIds([]);
  }

  function handleSplitConfirm() {
    if (!splitting) return;
    const parts = splitting.draft.split(/[\s　]+/).filter(Boolean);
    if (parts.length >= 2) {
      onSetItems((prev) => splitWordItem(prev, splitting.id, parts), true);
    }
    setSplitting(null);
  }

  function toggleMerge(id: string) {
    setMergeIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // The same span the merge itself will produce, so the preview cannot promise a
  // term the merge does not deliver.
  const mergePreview =
    mergeSelection.length >= 2
      ? sentenceSpanForTerms(
          sentence.text,
          words.filter((w) => mergeSelection.includes(w.id)).map((w) => w.term)
        )
      : "";

  // The analysis segments a sentence exhaustively, so anything still uncovered is
  // something it missed — show it in the sentence itself rather than as a count
  // the reader has to reconcile by eye.
  const coverage = useMemo(() => sentenceCoverage(sentence.text, words), [sentence.text, words]);
  const runs = useMemo(() => coverageRuns(sentence.text, coverage), [sentence.text, coverage]);

  return (
    <div className="min-w-0 rounded-xl border border-indigo-800/50 bg-gray-800/60 p-3 sm:p-4">
      <p
        ref={sentenceRef}
        onMouseUp={captureSelection}
        onTouchEnd={captureSelection}
        className="select-text break-words text-[17px] leading-relaxed text-gray-100 sm:text-[15px]"
      >
        {runs.map((run, i) =>
          run.gap ? (
            <span
              key={i}
              className="rounded-sm bg-amber-500/15 text-amber-200 underline decoration-amber-500/70 decoration-dotted underline-offset-4"
            >
              {run.text}
            </span>
          ) : (
            <span key={i}>{run.text}</span>
          )
        )}
      </p>

      {/* The sentence's own translation, read alongside the text it belongs to.
          Set apart by a left rule so it is never mistaken for the source. */}
      {showTranslation && (
        <p className="mt-2 break-words border-l-2 border-indigo-500/40 pl-2.5 text-[14px] leading-relaxed text-indigo-100/80 sm:text-[13px]">
          {sentence.translation?.trim() || (
            <span className="text-gray-600">{t("importNoTranslation")}</span>
          )}
        </p>
      )}

      {coverage.required > 0 && (
        <p className="mt-1.5 text-[11px] leading-snug">
          {coverage.complete ? (
            <span className="text-green-500/80">✓ {t("importCoverageDone")}</span>
          ) : (
            <>
              <span className="text-amber-400/90">
                {coverage.missing}
                {t("importCoverageMissing")}
              </span>
              <span className="text-gray-500"> — {t("importCoverageHint")}</span>
            </>
          )}
        </p>
      )}

      {selection && (
        <button
          type="button"
          onClick={() => {
            onSetItems((prev) => addWordItem(prev, sentence.index, selection), true);
            setSelection("");
            window.getSelection()?.removeAllRanges();
          }}
          className="mt-2 w-full break-words rounded-lg border border-blue-600 bg-blue-950/50 px-3 py-2 text-xs text-blue-200 hover:bg-blue-900/60 sm:w-auto sm:py-1.5"
        >
          ＋ 「{selection}」{t("importAddSelectionAsWord")}
        </button>
      )}

      {/* ---- Words ---- */}
      <section className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
          <h4 className="text-xs font-medium text-gray-300">{t("sectionVocabulary")}</h4>
          <span className="font-mono text-[11px] text-gray-600">{words.length}</span>
          <button
            type="button"
            onClick={() => onSetItems((prev) => addWordItem(prev, sentence.index, ""), true)}
            className="ml-auto shrink-0 whitespace-nowrap rounded px-1 py-1 text-[11px] text-gray-500 hover:text-blue-300"
          >
            ＋ {t("importAddWordRow")}
          </button>
        </div>

        {mergeSelection.length >= 2 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs">
            <span className="min-w-0 break-words text-amber-200">
              {mergeSelection.length}{t("importMergeCount")} → <b>{mergePreview}</b>
            </span>
            <button
              type="button"
              onClick={() => merge(mergeSelection)}
              className="ml-auto shrink-0 rounded-md bg-amber-600 px-3 py-1.5 text-white hover:bg-amber-500 sm:px-2.5 sm:py-1"
            >
              {t("importMerge")}
            </button>
            <button
              type="button"
              onClick={() => setMergeIds([])}
              className="shrink-0 px-1 py-1.5 text-gray-400 hover:text-gray-200 sm:py-1"
            >
              {t("cancel")}
            </button>
          </div>
        )}

        <ul className="space-y-1.5">
          {words.map((word, wi) => (
            <WordRow
              key={word.id}
              word={word}
              byId={byId}
              isChinese={language === "chinese"}
              // Merging with the row below is the whole of the common case — two
              // characters the analysis cut apart — so it gets a button of its own
              // beside "split" rather than only the multi-select checkboxes.
              onMergeNext={
                words[wi + 1] && !isLocked(words[wi + 1])
                  ? () => merge([word.id, words[wi + 1].id])
                  : undefined
              }
              inGroupA={inLibrary.has(word.term.trim())}
              groupBNames={groupBByTerm.get(word.term.trim()) ?? []}
              checked={mergeIds.includes(word.id)}
              splitting={splitting?.id === word.id ? splitting.draft : null}
              onToggleMerge={() => toggleMerge(word.id)}
              onStartSplit={() => setSplitting({ id: word.id, draft: word.term })}
              onSplitDraft={(draft) => setSplitting({ id: word.id, draft })}
              onSplitConfirm={handleSplitConfirm}
              onSplitCancel={() => setSplitting(null)}
              onPatch={(updates) => onPatchItem(word.id, updates)}
              onUndo={() => onSetItems((prev) => undoDerivation(prev, word.id), true)}
              onDelete={() => onPatchItem(word.id, { status: "skipped" }, true)}
              onRegister={() => onRegister(word.id)}
            />
          ))}
          {words.length === 0 && (
            <li className="text-xs text-gray-600">{t("importNoWordsInSentence")}</li>
          )}
        </ul>
      </section>

      {/* ---- Grammar ---- */}
      <section className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <h4 className="text-xs font-medium text-gray-300">{t("sectionGrammar")}</h4>
          <span className="font-mono text-[11px] text-gray-600">{grammar.length}</span>
          <button
            type="button"
            onClick={() => onSetItems((prev) => addGrammarItem(prev, sentence.index), true)}
            className="ml-auto shrink-0 whitespace-nowrap rounded px-1 py-1 text-[11px] text-gray-500 hover:text-emerald-300"
          >
            ＋ {t("importAddGrammarRow")}
          </button>
        </div>
        <ul className="space-y-1.5">
          {grammar.map((g) => (
            <GrammarRow
              key={g.id}
              item={g}
              onPatch={(updates) => onPatchItem(g.id, updates)}
              onDelete={() => onPatchItem(g.id, { status: "skipped" }, true)}
              onRegister={() => onRegister(g.id)}
            />
          ))}
          {grammar.length === 0 && (
            <li className="text-xs text-gray-600">{t("importNoGrammarInSentence")}</li>
          )}
        </ul>
      </section>
    </div>
  );
}

// ---------- rows ----------

function WordRow({
  word,
  byId,
  isChinese,
  onMergeNext,
  inGroupA,
  groupBNames,
  checked,
  splitting,
  onToggleMerge,
  onStartSplit,
  onSplitDraft,
  onSplitConfirm,
  onSplitCancel,
  onPatch,
  onUndo,
  onDelete,
  onRegister,
}: {
  word: ImportWordItem;
  byId: Map<string, ImportItem>;
  /** Pinyin gets the tone-mark input; every other language a plain one. */
  isChinese: boolean;
  /** Merge this row with the one below it. Absent on the last row of a sentence,
   *  and whenever the row below has already been handed to the queue. */
  onMergeNext?: () => void;
  /** Already in the library (= Group A) — the row is toned green so a word the
   *  user already has stands out from the ones still to be added. */
  inGroupA: boolean;
  /** Group B sets already holding this word; only knowable once its ID is. */
  groupBNames: string[];
  checked: boolean;
  splitting: string | null;
  onToggleMerge: () => void;
  onStartSplit: () => void;
  onSplitDraft: (draft: string) => void;
  onSplitConfirm: () => void;
  onSplitCancel: () => void;
  onPatch: (updates: Partial<ImportWordItem>) => void;
  onUndo: () => void;
  onDelete: () => void;
  onRegister: () => void;
}) {
  const { t } = useI18n();
  const locked = isLocked(word);
  const sources = (word.sourceIds ?? [])
    .map((id) => byId.get(id))
    .filter((i): i is ImportWordItem => i?.kind === "word");

  if (splitting !== null) {
    return (
      <li className="rounded-lg border border-amber-700/60 bg-amber-950/20 px-2.5 py-2">
        <p className="mb-1.5 text-[11px] text-amber-300/90">{t("importSplitHint")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            autoFocus
            value={splitting}
            onChange={(e) => onSplitDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); onSplitConfirm(); }
              if (e.key === "Escape") onSplitCancel();
            }}
            className="w-full min-w-0 rounded-md border border-amber-700/60 bg-gray-900 px-2 py-1.5 text-base text-gray-100 focus:border-amber-400 focus:outline-none sm:w-auto sm:flex-1 sm:py-1 sm:text-sm"
          />
          <button
            type="button"
            onClick={onSplitConfirm}
            className="shrink-0 rounded-md bg-amber-600 px-3 py-1.5 text-xs text-white hover:bg-amber-500 sm:px-2.5 sm:py-1"
          >
            {t("importSplit")}
          </button>
          <button
            type="button"
            onClick={onSplitCancel}
            className="shrink-0 px-1 py-1.5 text-xs text-gray-400 hover:text-gray-200 sm:py-1"
          >
            {t("cancel")}
          </button>
        </div>
      </li>
    );
  }

  // Below `sm` the row becomes two stacked blocks — term/reading over the actions —
  // because term + a fixed-width reading + four controls on one line leaves the term
  // field about 100px wide on a phone. From `sm` it collapses back to the single row.
  return (
    <li
      className={`rounded-lg px-2.5 py-2 ${
        inGroupA
          ? "border-l-4 border-emerald-500/70 bg-emerald-950/30"
          : "bg-gray-900/50"
      }`}
    >
      <div className="sm:flex sm:items-center sm:gap-2">
        <div className="flex items-start gap-2 sm:min-w-0 sm:flex-1 sm:items-center">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggleMerge}
            disabled={locked}
            title={t("importSelectToMerge")}
            className="mt-2.5 h-4 w-4 shrink-0 accent-amber-500 disabled:opacity-30 sm:mt-0 sm:h-3.5 sm:w-3.5"
          />
          <div className="min-w-0 flex-1 space-y-1.5 sm:flex sm:items-center sm:gap-2 sm:space-y-0">
            <input
              value={word.term}
              onChange={(e) => onPatch({ term: e.target.value })}
              disabled={locked}
              placeholder={t("words")}
              className={`block w-full min-w-0 rounded-md border bg-gray-950/60 px-2 py-1.5 text-base focus:border-blue-500 focus:outline-none disabled:border-transparent disabled:bg-transparent sm:flex-1 sm:py-1 sm:text-sm ${
                inGroupA
                  ? "border-emerald-700/60 font-medium text-emerald-200 disabled:text-emerald-200"
                  : "border-gray-700 text-gray-100 disabled:text-gray-400"
              }`}
            />
            {isChinese ? (
              // Tone marks cannot be typed on a normal keyboard, so the reading
              // field is the shared pinyin input (hao3 → hǎo, plus the palette).
              // Its panel floats: in a list this dense, pushing every row below it
              // down would be worse than an overlay.
              <PinyinInput
                value={word.transliteration ?? ""}
                onChange={(value) => onPatch({ transliteration: value })}
                disabled={locked}
                placeholder={t("importReading")}
                wrapperClassName="w-full min-w-0 sm:w-24 sm:shrink-0"
                floatingPanel
                className="block w-full min-w-0 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-base text-gray-300 focus:border-blue-500 focus:outline-none disabled:border-transparent disabled:bg-transparent sm:py-1 sm:text-xs"
              />
            ) : (
              <input
                value={word.transliteration ?? ""}
                onChange={(e) => onPatch({ transliteration: e.target.value })}
                disabled={locked}
                placeholder={t("importReading")}
                className="block w-full min-w-0 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-base text-gray-300 focus:border-blue-500 focus:outline-none disabled:border-transparent disabled:bg-transparent sm:w-24 sm:shrink-0 sm:py-1 sm:text-xs"
              />
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2 pl-6 sm:mt-0 sm:shrink-0 sm:pl-0">
          <StatusControl
            status={word.status}
            error={word.error}
            rescuedAsDraft={word.rescuedAsDraft}
            addLabel={word.existingWordId ? t("importAddToGroups") : t("importAdd")}
            onRegister={onRegister}
          />
          {!locked && (
            <>
              {onMergeNext && (
                <button
                  type="button"
                  onClick={onMergeNext}
                  title={t("importMergeNextHint")}
                  className="ml-auto shrink-0 whitespace-nowrap rounded px-1.5 py-1.5 text-[11px] text-gray-500 hover:text-amber-300 sm:ml-0 sm:py-0.5"
                >
                  {t("importMergeNext")}
                </button>
              )}
              <button
                type="button"
                onClick={onStartSplit}
                title={t("importSplit")}
                className={`shrink-0 whitespace-nowrap rounded px-1.5 py-1.5 text-[11px] text-gray-500 hover:text-amber-300 sm:py-0.5 ${
                  onMergeNext ? "" : "ml-auto sm:ml-0"
                }`}
              >
                {t("importSplit")}
              </button>
              <button
                type="button"
                onClick={onDelete}
                title={t("importRemoveRow")}
                className="shrink-0 rounded px-1.5 py-1.5 text-xs text-gray-600 hover:text-red-400 sm:py-0.5"
              >
                ✕
              </button>
            </>
          )}
        </div>
      </div>

      {/* Editable, because a split or a merge leaves it empty on purpose: the parts
          of a compound do not inherit its gloss, and nothing else can supply one. */}
      {locked ? (
        word.meaning && (
          <p className="mt-1 break-words pl-6 text-[11px] text-gray-500">{word.meaning}</p>
        )
      ) : (
        <input
          value={word.meaning ?? ""}
          onChange={(e) => onPatch({ meaning: e.target.value })}
          placeholder={t("importMeaningPlaceholder")}
          className="mt-1.5 ml-6 block w-[calc(100%-1.5rem)] min-w-0 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-base text-gray-300 placeholder-gray-600 focus:border-blue-500 focus:outline-none sm:py-1 sm:text-xs"
        />
      )}
      {sources.length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-[11px] text-gray-500">
          <span className="min-w-0 break-words">
            {word.origin === "merge" ? t("importMergedFrom") : t("importSplitFrom")}:{" "}
            {sources.map((s) => s.term).join(" + ")}
          </span>
          {!locked && (
            <button
              type="button"
              onClick={onUndo}
              className="shrink-0 py-1 text-gray-500 underline hover:text-gray-300"
            >
              {t("importUndo")}
            </button>
          )}
        </p>
      )}
      {(inGroupA || groupBNames.length > 0) && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 pl-6 text-[11px]">
          {inGroupA && (
            <span className="shrink-0 rounded border border-emerald-600/60 bg-emerald-900/40 px-1.5 py-0.5 font-medium text-emerald-300">
              ✓ {t("importInGroupA")}
            </span>
          )}
          {groupBNames.length > 0 && (
            <span className="min-w-0 truncate rounded border border-amber-600/60 bg-amber-900/30 px-1.5 py-0.5 font-medium text-amber-300">
              ✓ {t("importInGroupB")}: {groupBNames.join(", ")}
            </span>
          )}
          {word.existingWordId && word.status === "pending" && (
            <span className="min-w-0 break-words text-gray-500">{t("importAlreadyInDb")}</span>
          )}
        </p>
      )}
    </li>
  );
}

function GrammarRow({
  item,
  onPatch,
  onDelete,
  onRegister,
}: {
  item: ImportGrammarItem;
  onPatch: (updates: Partial<ImportGrammarItem>) => void;
  onDelete: () => void;
  onRegister: () => void;
}) {
  const { t } = useI18n();
  const locked = isLocked(item);
  return (
    <li className="rounded-lg bg-gray-900/50 px-2.5 py-2">
      <div className="sm:flex sm:items-center sm:gap-2">
        <input
          value={item.statement}
          onChange={(e) => onPatch({ statement: e.target.value })}
          disabled={locked}
          placeholder={t("importStatementPlaceholder")}
          className="block w-full min-w-0 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-base text-gray-100 focus:border-emerald-500 focus:outline-none disabled:border-transparent disabled:bg-transparent disabled:text-gray-400 sm:flex-1 sm:py-1 sm:text-sm"
        />
        <div className="mt-2 flex items-center gap-2 sm:mt-0 sm:shrink-0">
          <StatusControl
            status={item.status}
            error={item.error}
            rescuedAsDraft={item.rescuedAsDraft}
            addLabel={t("importAdd")}
            onRegister={onRegister}
          />
          {!locked && (
            <button
              type="button"
              onClick={onDelete}
              className="ml-auto shrink-0 rounded px-1.5 py-1.5 text-xs text-gray-600 hover:text-red-400 sm:ml-0 sm:py-0.5"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <input
        value={item.description}
        onChange={(e) => onPatch({ description: e.target.value })}
        disabled={locked}
        placeholder={t("importDescriptionPlaceholder")}
        className="mt-1.5 block w-full min-w-0 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-base text-gray-300 focus:border-emerald-500 focus:outline-none disabled:border-transparent disabled:bg-transparent sm:py-1 sm:text-xs"
      />
    </li>
  );
}

/**
 * The add button and, once pressed, an honest account of what happened. `queued`
 * is deliberately not a checkmark: the write may still fail, and a session
 * reloaded mid-flight cannot know either way until it is reconciled.
 */
function StatusControl({
  status,
  error,
  rescuedAsDraft,
  addLabel,
  onRegister,
}: {
  status: ImportItem["status"];
  error?: string;
  rescuedAsDraft?: boolean;
  addLabel: string;
  onRegister: () => void;
}) {
  const { t } = useI18n();

  if (status === "registered") {
    return <span className="whitespace-nowrap text-xs text-green-400">✓ {t("importRegistered")}</span>;
  }
  if (status === "duplicate") {
    return (
      <span className="whitespace-nowrap text-xs text-gray-400" title={t("importDuplicateHint")}>
        ✓ {t("importAlreadyRegistered")}
      </span>
    );
  }
  if (status === "queued") {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-amber-300">
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
        {t("importRegisteringItem")}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
        <span className="text-red-400" title={error}>
          ✗ {t("importAddFailed")}
        </span>
        {rescuedAsDraft && (
          <span className="text-[11px] text-gray-500">{t("importSavedAsDraft")}</span>
        )}
        <button
          type="button"
          onClick={onRegister}
          className="shrink-0 rounded-md border border-gray-600 px-2 py-1 text-[11px] text-gray-300 hover:border-indigo-500 hover:text-indigo-300 sm:py-0.5"
        >
          {t("importRetry")}
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onRegister}
      className="shrink-0 whitespace-nowrap rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 sm:px-2.5 sm:py-1"
    >
      {addLabel}
    </button>
  );
}
