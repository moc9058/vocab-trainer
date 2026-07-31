import { useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import PinyinInput from "../PinyinInput";
import {
  addGrammarItem,
  addWordItem,
  coverageRuns,
  isLocked,
  materializeGaps,
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
import type { GroupMembership } from "../../hooks/useImportLibraryStatus";

const NO_GROUPS: GroupMembership = { a: [], b: [], aIds: [] };

/**
 * Where this review is filing things, resolved to display names.
 *
 * Group A is per-domain (a word group and a grammar group are unrelated sets) while
 * Group B is ONE cross-domain study set chosen by name — which is why the A half is
 * split in two here and the B half is not.
 */
export interface ImportDestination {
  wordGroupId?: string;
  wordGroupName?: string;
  grammarGroupId?: string;
  grammarGroupName?: string;
  groupBNames: string[];
}

/** One row's view of the destinations — the A side already picked for its domain. */
interface RowDestination {
  aGroupId?: string;
  aGroupName?: string;
  bNames: string[];
}

interface Props {
  /** Backend full-name language ("chinese"), which is what gates the pinyin input. */
  language: string;
  sentence: ImportSentence;
  /** The whole item list — `sourceIds` on a merged row point at tombstones in it. */
  items: ImportItem[];
  onSetItems: (updater: (items: ImportItem[]) => ImportItem[], immediate?: boolean) => void;
  onPatchItem: (id: string, updates: Partial<ImportItem>, immediate?: boolean) => void;
  /** One press writes ONE destination: the Group A lesson group or the Group B set. */
  onRegister: (id: string, target: "A" | "B") => void;
  /** Live from the destination rail — changing it mid-review re-labels every button. */
  destination: ImportDestination;
  /** Sentence translation visibility is a per-user preference owned by `ImportReview`. */
  showTranslation: boolean;
  /** Terms already in the library (= in Group A), keyed by term so a word registered
   *  from one sentence lights up its other occurrences too. The fallback signal for
   *  a term whose word ID — and therefore whose group names — is not known. */
  inLibrary: Set<string>;
  /** Group names already holding a term, split by meta-group. */
  wordGroupsByTerm: Map<string, GroupMembership>;
  /** Group names already holding a grammar item, keyed by its ID. */
  grammarGroupsById: Map<string, GroupMembership>;
}

export default function ImportSentenceCard({
  language,
  sentence,
  items,
  onSetItems,
  onPatchItem,
  onRegister,
  destination,
  showTranslation,
  inLibrary,
  wordGroupsByTerm,
  grammarGroupsById,
}: Props) {
  const { t } = useI18n();
  const { words, grammar } = sentenceItems(items, sentence.index);
  const wordDestination: RowDestination = {
    aGroupId: destination.wordGroupId,
    aGroupName: destination.wordGroupName,
    bNames: destination.groupBNames,
  };
  const grammarDestination: RowDestination = {
    aGroupId: destination.grammarGroupId,
    aGroupName: destination.grammarGroupName,
    bNames: destination.groupBNames,
  };
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
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-snug">
          {coverage.complete ? (
            <span className="text-green-500/80">✓ {t("importCoverageDone")}</span>
          ) : (
            <>
              <span className="text-amber-400/90">
                {coverage.missing}
                {t("importCoverageMissing")}
              </span>
              {/* Editing a row can reopen a gap the analysis had covered. One click
                  closes it again — except where coverage is only approximate, in
                  which case the runs are a guess and a human should place them. */}
              {coverage.approximate ? (
                <span className="text-gray-500">— {t("importCoverageHint")}</span>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    onSetItems(
                      (prev) => materializeGaps(prev, sentence.index, sentence.text),
                      true
                    )
                  }
                  className="rounded border border-amber-700/60 px-1.5 py-0.5 text-amber-300 hover:border-amber-500 hover:text-amber-200"
                >
                  ＋ {t("importCoverageMaterialize")}
                </button>
              )}
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
              groups={wordGroupsByTerm.get(word.term.trim()) ?? NO_GROUPS}
              destination={wordDestination}
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
              onRegister={(target) => onRegister(word.id, target)}
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
              groups={
                (g.existingGrammarId && grammarGroupsById.get(g.existingGrammarId)) || NO_GROUPS
              }
              destination={grammarDestination}
              onPatch={(updates) => onPatchItem(g.id, updates)}
              onDelete={() => onPatchItem(g.id, { status: "skipped" }, true)}
              onRegister={(target) => onRegister(g.id, target)}
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
  groups,
  destination,
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
  /** The groups actually holding this word; only knowable once its ID is, which is
   *  why `inGroupA` stays the fallback rather than being derived from this. */
  groups: GroupMembership;
  destination: RowDestination;
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
  onRegister: (target: "A" | "B") => void;
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
          : word.origin === "gap"
          ? // Not a proposal from the analysis but a hole in it, filled in verbatim:
            // the run may well be several words, and it has no reading or meaning.
            "border-l-4 border-amber-600/60 bg-amber-950/20"
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
              // Retyping the term makes this a different word, so the ID that was
              // resolved for the old one must go with it — otherwise "Add to groups"
              // would quietly write membership for a word no longer on this row.
              onChange={(e) => onPatch({ term: e.target.value, existingWordId: undefined })}
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

        <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 sm:mt-0 sm:shrink-0 sm:pl-0">
          <RegisterControls
            status={word.status}
            error={word.error}
            rescuedAsDraft={word.rescuedAsDraft}
            target={word.target}
            destination={destination}
            groups={groups}
            inLibrary={inGroupA}
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
      {word.origin === "gap" && !locked && (
        <p className="mt-1 pl-6 text-[11px] leading-snug text-amber-400/80">
          {t("importGapRowHint")}
        </p>
      )}
      <MembershipChips
        groups={groups}
        inLibrary={inGroupA}
        indent
        note={
          word.existingWordId && word.status === "pending" ? t("importAlreadyInDb") : undefined
        }
      />
    </li>
  );
}

/**
 * Where an item already lives.
 *
 * Group NAMES whenever the entity's ID is known, since the group read can then be
 * inverted for it; the bare "in Group A" flag otherwise. The two are not the same
 * claim: a term can be in the library and in no Group A group at all, and a word
 * proven to exist by a 409 whose ID recovery failed has no ID to look names up by.
 * Collapsing them would either drop the indicator or invent a group.
 */
function MembershipChips({
  groups,
  inLibrary,
  indent = false,
  note,
}: {
  groups: GroupMembership;
  inLibrary: boolean;
  /** Align under the merge checkbox, as the word rows do. */
  indent?: boolean;
  note?: string;
}) {
  const { t } = useI18n();
  const showA = inLibrary || groups.a.length > 0;
  if (!showA && groups.b.length === 0 && !note) return null;
  return (
    <p
      className={`mt-1 flex flex-wrap items-center gap-1.5 text-[11px] ${indent ? "pl-6" : ""}`}
    >
      {showA && (
        // `max-w-full truncate` because a long group name is otherwise an
        // unbreakable flex item and pushes the review screen into horizontal scroll.
        <span className="min-w-0 max-w-full truncate rounded border border-emerald-600/60 bg-emerald-900/40 px-1.5 py-0.5 font-medium text-emerald-300">
          ✓ {t("importInGroupA")}
          {groups.a.length > 0 && `: ${groups.a.join(", ")}`}
        </span>
      )}
      {groups.b.length > 0 && (
        <span className="min-w-0 max-w-full truncate rounded border border-amber-600/60 bg-amber-900/30 px-1.5 py-0.5 font-medium text-amber-300">
          ✓ {t("importInGroupB")}: {groups.b.join(", ")}
        </span>
      )}
      {note && <span className="min-w-0 break-words text-gray-500">{note}</span>}
    </p>
  );
}

function GrammarRow({
  item,
  groups,
  destination,
  onPatch,
  onDelete,
  onRegister,
}: {
  item: ImportGrammarItem;
  /** Only populated once this statement has been registered in this review —
   *  grammar has no analysis-time existence check to seed it from. */
  groups: GroupMembership;
  destination: RowDestination;
  onPatch: (updates: Partial<ImportGrammarItem>) => void;
  onDelete: () => void;
  onRegister: (target: "A" | "B") => void;
}) {
  const { t } = useI18n();
  const locked = isLocked(item);
  const registered = Boolean(item.existingGrammarId);
  return (
    <li
      className={`rounded-lg px-2.5 py-2 ${
        registered ? "border-l-4 border-emerald-500/70 bg-emerald-950/30" : "bg-gray-900/50"
      }`}
    >
      <div className="sm:flex sm:items-center sm:gap-2">
        <input
          value={item.statement}
          onChange={(e) => onPatch({ statement: e.target.value })}
          disabled={locked}
          placeholder={t("importStatementPlaceholder")}
          className="block w-full min-w-0 rounded-md border border-gray-700 bg-gray-950/60 px-2 py-1.5 text-base text-gray-100 focus:border-emerald-500 focus:outline-none disabled:border-transparent disabled:bg-transparent disabled:text-gray-400 sm:flex-1 sm:py-1 sm:text-sm"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2 sm:mt-0 sm:shrink-0">
          <RegisterControls
            status={item.status}
            error={item.error}
            rescuedAsDraft={item.rescuedAsDraft}
            target={item.target}
            destination={destination}
            groups={groups}
            // A sibling row may already have created this pattern; such a row can
            // only extend group membership, exactly as an existing word's row does.
            inLibrary={registered}
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
      <MembershipChips
        groups={groups}
        inLibrary={registered}
        note={registered && item.status === "pending" ? t("importAlreadyInDb") : undefined}
      />
    </li>
  );
}

/**
 * One button per destination, and once pressed an honest account of what happened.
 *
 * Group A and Group B are separate presses because they mean different things: A is
 * the lesson the item belongs to, B is the not-yet-memorized set being drilled. A
 * single button could not express "already in A, still needs B" — the ordinary state
 * of an article that repeats vocabulary the user already owns — and it forced every
 * add to write both destinations at once.
 *
 * The ✓ is read from ACTUAL membership (the group documents, plus the optimistic
 * overlay of writes the re-read has not caught up with), not from `status`: status is
 * the outcome of the last write THIS review made, whereas what the user needs to know
 * is where the item sits now. `status` is only consulted for the transient states —
 * which button is spinning, which one failed — and that is what `target` disambiguates.
 */
function RegisterControls({
  status,
  error,
  rescuedAsDraft,
  target,
  destination,
  groups,
  inLibrary,
  onRegister,
}: {
  status: ImportItem["status"];
  error?: string;
  rescuedAsDraft?: boolean;
  /** Which destination the last (or in-flight) write was aimed at. */
  target?: "A" | "B";
  destination: RowDestination;
  groups: GroupMembership;
  /** Known to be in the library but with no ID to look group names up by — the
   *  fallback for deciding "A is done" when no A destination is selected. */
  inLibrary: boolean;
  onRegister: (target: "A" | "B") => void;
}) {
  const { t } = useI18n();
  const busy = status === "queued";

  // With a destination chosen, "done" is a membership question and the group read
  // answers it. Without one, the press only creates the item, so the write's own
  // outcome is all there is to go on.
  const doneA = destination.aGroupId
    ? groups.aIds.includes(destination.aGroupId)
    : status === "registered" || status === "duplicate" || inLibrary;
  const doneB =
    destination.bNames.length > 0 && destination.bNames.every((name) => groups.b.includes(name));

  // Already in a DIFFERENT Group A group: the add is a move, since a word belongs to
  // exactly one lesson. Spelled out in the tooltip so it is never a surprise.
  const movesFrom = !doneA && destination.aGroupName ? groups.a : [];

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <DestinationButton
        badge="A"
        tone="a"
        name={destination.aGroupName}
        fallbackLabel={t("importAdd")}
        title={
          movesFrom.length > 0
            ? `${t("importAddToDestA")}: ${movesFrom.join(", ")} → ${destination.aGroupName}`
            : t("importAddToDestA")
        }
        done={doneA}
        busy={busy && target === "A"}
        failed={status === "failed" && target === "A"}
        disabled={busy}
        error={error}
        rescuedAsDraft={rescuedAsDraft}
        onRegister={() => onRegister("A")}
      />
      {/* Nothing to add to until a Group B set is picked in the destination rail. */}
      {destination.bNames.length > 0 && (
        <DestinationButton
          badge="B"
          tone="b"
          name={destination.bNames.join(" · ")}
          fallbackLabel={t("importAdd")}
          title={t("importAddToDestB")}
          done={doneB}
          busy={busy && target === "B"}
          failed={status === "failed" && target === "B"}
          disabled={busy}
          error={error}
          rescuedAsDraft={rescuedAsDraft}
          onRegister={() => onRegister("B")}
        />
      )}
    </span>
  );
}

/**
 * One destination's control, in whichever of its four states applies. `queued` is
 * deliberately not a checkmark: the write may still fail, and a session reloaded
 * mid-flight cannot know either way until it is reconciled.
 */
function DestinationButton({
  badge,
  tone,
  name,
  fallbackLabel,
  title,
  done,
  busy,
  failed,
  disabled,
  error,
  rescuedAsDraft,
  onRegister,
}: {
  badge: string;
  /** Matches the destination rail's dots: Group A indigo, Group B amber. */
  tone: "a" | "b";
  name?: string;
  /** Shown when no group is selected — the press then only creates the item. */
  fallbackLabel: string;
  title: string;
  done: boolean;
  busy: boolean;
  failed: boolean;
  disabled: boolean;
  error?: string;
  rescuedAsDraft?: boolean;
  onRegister: () => void;
}) {
  const { t } = useI18n();
  const accent =
    tone === "a"
      ? "border-indigo-700/60 bg-indigo-950/40 text-indigo-300"
      : "border-amber-700/60 bg-amber-950/30 text-amber-300";

  if (done) {
    return (
      <span
        title={name ? `${badge}: ${name}` : t("importRegistered")}
        className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-1 text-[11px] ${accent}`}
      >
        ✓ {badge}
      </span>
    );
  }
  if (busy) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-amber-300">
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
        {t("importRegisteringItem")}
      </span>
    );
  }
  if (failed) {
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
          {badge} {t("importRetry")}
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onRegister}
      disabled={disabled}
      title={title}
      className={`inline-flex min-w-0 shrink items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40 sm:py-1 ${
        tone === "a" ? "bg-indigo-600 hover:bg-indigo-500" : "bg-amber-600 hover:bg-amber-500"
      }`}
    >
      {name ? (
        <>
          <span className="shrink-0 rounded bg-black/25 px-1 text-[10px] leading-4">{badge}</span>
          {/* Capped and truncated: a long group name is otherwise an unbreakable
              flex item and drags the review screen into horizontal scroll. */}
          <span className="min-w-0 max-w-[6.5rem] truncate">{name}</span>
        </>
      ) : (
        <span className="whitespace-nowrap">{fallbackLabel}</span>
      )}
    </button>
  );
}
