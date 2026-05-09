import { useEffect, useState, useCallback, useRef } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { getWords, getFilters, updateWord, deleteWord, checkTerms, smartAddWord } from "../api/vocab";
import { getFlaggedWords, flagWord as apiFlagWord, unflagWord as apiUnflagWord } from "../api/flagged";
import RubyText from "./RubyText";
import WordFormModal from "./WordFormModal";
import SmartAddWordModal from "./SmartAddWordModal";
import { displayTranslation, type Word, type PaginatedResult } from "../types";
import { urlLanguageToIsoCode } from "../settings/defaults";

type SmartAddPayload = {
  term: string;
  transliteration?: string;
  definitions?: { partOfSpeech: string; text: Record<string, string> }[];
  topics?: string[];
  examples?: { sentence: string; translation: string }[];
  level?: string;
  flag?: boolean;
};

interface Props {
  language: string;
  onBack: () => void;
  initialExpandId?: string;
  initialSearch?: string;
  refreshSignal?: number;
  onQueue?: (term: string, language: string, payload: SmartAddPayload) => void;
}

export default function WordList({ language, onBack, initialExpandId, initialSearch, refreshSignal, onQueue }: Props) {
  const { t } = useI18n();
  const currentIsoCode = urlLanguageToIsoCode(language) ?? language;
  const [result, setResult] = useState<PaginatedResult<Word> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch ?? "");
  const [topic, setTopic] = useState("");
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [existingTerms, setExistingTerms] = useState<Map<string, string>>(new Map());
  const [busySegments, setBusySegments] = useState<Set<string>>(new Set());
  const [segmentFlags, setSegmentFlags] = useState<Map<string, boolean>>(new Map());
  const [editingExample, setEditingExample] = useState<string | null>(null);
  const [editSegments, setEditSegments] = useState<Array<{ text: string; transliteration?: string; id?: string }>>([]);
  const [editKnownTerms, setEditKnownTerms] = useState<Map<string, string>>(new Map());
  const [editPinyinIndex, setEditPinyinIndex] = useState<number | null>(null);
  const [filterOptions, setFilterOptions] = useState<{
    topics: string[];
    categories: string[];
    levels: string[];
  } | null>(null);
  const [showSmartAdd, setShowSmartAdd] = useState(false);
  const [editingWord, setEditingWord] = useState<Word | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch ?? "");
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const isInitialMount = useRef(true);
  const requestIdRef = useRef(0);
  const scrollToExpandedRef = useRef(false);
  const silentRefreshRef = useRef(false);
  const checkTermsVersionRef = useRef(0);
  const initialExpandAppliedRef = useRef(false);

  // Expand and scroll to initialExpandId once the first fetch completes
  useEffect(() => {
    if (!initialExpandId || loading || initialExpandAppliedRef.current) return;
    initialExpandAppliedRef.current = true;
    setExpandedId(initialExpandId);
    scrollToExpandedRef.current = true;
  }, [initialExpandId, loading]);

  // Fetch flagged word IDs on mount
  useEffect(() => {
    getFlaggedWords(language)
      .then(({ words }) => setFlaggedIds(new Set(words.map((w) => w.id))))
      .catch(() => setFlaggedIds(new Set()));
  }, [language]);

  async function handleToggleFlag(wordId: string) {
    if (flaggedIds.has(wordId)) {
      await apiUnflagWord(language, wordId);
      setFlaggedIds((prev) => { const next = new Set(prev); next.delete(wordId); return next; });
    } else {
      await apiFlagWord(language, wordId);
      setFlaggedIds((prev) => new Set(prev).add(wordId));
    }
  }

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  async function handleUpdateWord(data: Omit<Word, "id"> & { id?: string }) {
    if (!data.id) return;
    const { id, ...updates } = data as Word;
    await updateWord(language, id, updates);
    await fetchData();
  }

  async function handleDeleteWord(wordId: string) {
    await deleteWord(language, wordId);
    setDeletingId(null);
    setExpandedId(null);
    setSelectedIds((prev) => {
      if (!prev.has(wordId)) return prev;
      const next = new Set(prev);
      next.delete(wordId);
      return next;
    });
    await fetchData();
  }

  function toggleSelected(wordId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(wordId)) next.delete(wordId);
      else next.add(wordId);
      return next;
    });
  }

  function toggleSelectAllOnPage() {
    const pageIds = result?.items.map((w) => w.id) ?? [];
    if (pageIds.length === 0) return;
    const allSelected = pageIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    setBulkDeleting(true);
    try {
      const ids = Array.from(selectedIds);
      // Delete sequentially to keep load on the backend predictable.
      for (const id of ids) {
        await deleteWord(language, id);
      }
      setSelectedIds(new Set());
      setExpandedId(null);
      setShowBulkDeleteConfirm(false);
      await fetchData();
    } finally {
      setBulkDeleting(false);
    }
  }

  function refreshExistingTerms(word: Word) {
    const allTexts = [
      ...new Set(
        word.examples.flatMap((ex) => ex.segments?.map((s) => s.text).filter((t) => t.trim().length > 0 && !/^\p{P}+$/u.test(t)) ?? [])
      ),
    ];
    if (allTexts.length === 0) {
      setExistingTerms(new Map());
      return;
    }
    const v = ++checkTermsVersionRef.current;
    checkTerms(language, allTexts)
      .then(({ existing }) => {
        if (v === checkTermsVersionRef.current)
          setExistingTerms(new Map(Object.entries(existing)));
      })
      .catch(() => {
        if (v === checkTermsVersionRef.current) setExistingTerms(new Map());
      });
  }

  function handleToggleExpand(word: Word) {
    if (expandedId === word.id) {
      setExpandedId(null);
      return;
    }
    if (editingExample) handleCancelEdit();
    setExpandedId(word.id);
    setBusySegments(new Set());
    refreshExistingTerms(word);
  }

  async function handleAddSegmentWord(term: string, sentence: string, translation: string) {
    if (existingTerms.has(term)) return;
    checkTermsVersionRef.current++; // invalidate any in-flight checkTerms so it won't overwrite
    setBusySegments((prev) => new Set(prev).add(term));
    try {
      const flag = segmentFlags.get(term) ?? true;
      const { generatedWords: gw, ...word } = await smartAddWord(language, {
        term,
        examples: [{ sentence, translation }],
        flag,
      });
      setExistingTerms((prev) => new Map(prev).set(term, word.id));
      if (flag) {
        setFlaggedIds((prev) => new Set(prev).add(word.id));
      }
      setResult((prev) => {
        if (!prev) return prev;
        const newItems = [word, ...(gw ?? []), ...prev.items];
        return { ...prev, items: newItems, total: prev.total + 1 + (gw?.length ?? 0) };
      });
    } catch {
      // Word may have been saved despite the error; re-check to show correct button state
      const expandedWord = result?.items.find((w) => w.id === expandedId);
      if (expandedWord) {
        const allTexts = [...new Set(
          expandedWord.examples.flatMap((ex) =>
            ex.segments?.map((s) => s.text).filter((t) => t.trim().length > 0 && !/^\p{P}+$/u.test(t)) ?? []
          )
        )];
        if (allTexts.length > 0) {
          const v = ++checkTermsVersionRef.current;
          checkTerms(language, allTexts)
            .then(({ existing }) => {
              if (v === checkTermsVersionRef.current)
                setExistingTerms(new Map(Object.entries(existing)));
            })
            .catch(() => {});
        }
      }
    } finally {
      setBusySegments((prev) => { const next = new Set(prev); next.delete(term); return next; });
    }
  }

  // --- Segment edit mode ---

  async function lookupSegmentTerms(segs: Array<{ text: string }>) {
    const texts = [...new Set(segs.map((s) => s.text).filter((t) => t.trim().length > 0 && !/^\p{P}+$/u.test(t)))];
    if (texts.length === 0) return new Map<string, string>();
    try {
      const { existing } = await checkTerms(language, texts);
      return new Map(Object.entries(existing));
    } catch {
      return new Map<string, string>();
    }
  }

  async function handleStartEdit(word: Word, exampleIndex: number) {
    const segs = (word.examples[exampleIndex].segments ?? []).map((s) => ({ ...s }));
    const knownTerms = await lookupSegmentTerms(segs);
    const activatedSegs = segs.map((seg) => {
      const wordId = knownTerms.get(seg.text);
      return wordId ? { ...seg, id: wordId } : seg;
    });
    setEditingExample(`${word.id}:${exampleIndex}`);
    setEditSegments(activatedSegs);
    setEditPinyinIndex(null);
    setEditKnownTerms(knownTerms);
  }

  function handleCancelEdit() {
    setEditingExample(null);
    setEditSegments([]);
    setEditKnownTerms(new Map());
    setEditPinyinIndex(null);
  }

  async function refreshEditKnownTerms(segs: Array<{ text: string }>) {
    setEditKnownTerms(await lookupSegmentTerms(segs));
  }

  async function handleSplitSegment(segIndex: number) {
    const seg = editSegments[segIndex];
    const chars = Array.from(seg.text);
    if (chars.length <= 1) return;
    const syllables = seg.transliteration?.split(/\s+/) ?? [];
    const newSegs = chars.map((char, ci) => ({
      text: char,
      transliteration: ci < syllables.length ? syllables[ci] : undefined,
    }));
    const updated = [...editSegments.slice(0, segIndex), ...newSegs, ...editSegments.slice(segIndex + 1)];
    setEditSegments(updated);
    setEditPinyinIndex(null);
    await refreshEditKnownTerms(updated);
  }

  async function handleMergeSegments(segIndex: number) {
    const s1 = editSegments[segIndex];
    const s2 = editSegments[segIndex + 1];
    const merged = {
      text: s1.text + s2.text,
      transliteration: [s1.transliteration, s2.transliteration].filter(Boolean).join(" ") || undefined,
    };
    const updated = [...editSegments.slice(0, segIndex), merged, ...editSegments.slice(segIndex + 2)];
    setEditSegments(updated);
    setEditPinyinIndex(null);
    await refreshEditKnownTerms(updated);
  }

  function handleToggleEditSegmentActive(segIndex: number) {
    const seg = editSegments[segIndex];
    if (!seg || /^\p{P}+$/u.test(seg.text) || seg.text.trim().length === 0) return;
    const wordId = editKnownTerms.get(seg.text);
    setEditSegments((prev) => prev.map((s, i) => {
      if (i !== segIndex) return s;
      if (s.id) {
        const { id: _id, ...rest } = s;
        return rest;
      }
      return wordId ? { ...s, id: wordId } : s;
    }));
    setEditPinyinIndex(null);
  }

  function handleEditPinyinChange(segIndex: number, value: string) {
    setEditSegments((prev) => prev.map((s, i) => (i === segIndex ? { ...s, transliteration: value || undefined } : s)));
  }

  function handleInsertToneChar(char: string) {
    if (editPinyinIndex === null) return;
    const input = document.getElementById("pinyin-edit-input") as HTMLInputElement | null;
    const cur = editSegments[editPinyinIndex]?.transliteration ?? "";
    const start = input?.selectionStart ?? cur.length;
    const end = input?.selectionEnd ?? cur.length;
    const newValue = cur.slice(0, start) + char + cur.slice(end);
    const newPos = start + char.length;
    handleEditPinyinChange(editPinyinIndex, newValue);
    requestAnimationFrame(() => {
      const inp = document.getElementById("pinyin-edit-input") as HTMLInputElement | null;
      if (inp) { inp.focus(); inp.selectionStart = inp.selectionEnd = newPos; }
    });
  }

  async function handleSaveEdit() {
    if (!editingExample) return;
    const [wordId, exIndexStr] = editingExample.split(":");
    const exampleIndex = parseInt(exIndexStr, 10);
    const word = result?.items.find((w) => w.id === wordId);
    if (!word) return;
    const latestKnownTerms = await lookupSegmentTerms(editSegments);
    setEditKnownTerms(latestKnownTerms);
    const finalSegments = editSegments.map((seg) => {
      const wId = latestKnownTerms.get(seg.text);
      return wId ? { ...seg, id: wId } : { text: seg.text, transliteration: seg.transliteration };
    });
    const updatedExamples = word.examples.map((ex, i) =>
      i === exampleIndex ? { ...ex, segments: finalSegments } : ex
    );
    await updateWord(language, wordId, { examples: updatedExamples });
    const touchedById = new Map(
      updatedExamples.filter((ex): ex is typeof ex & { id: string } => !!ex.id).map((ex) => [ex.id, ex]),
    );
    setResult((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((w) => {
          if (w.id === wordId) return { ...w, examples: updatedExamples };
          if (!w.examples.some((ex) => ex.id && touchedById.has(ex.id))) return w;
          return {
            ...w,
            examples: w.examples.map((ex) => {
              if (!ex.id) return ex;
              const updated = touchedById.get(ex.id);
              if (!updated) return ex;
              return {
                ...ex,
                sentence: updated.sentence,
                translation: updated.translation,
                segments: updated.segments,
              };
            }),
          };
        }),
      };
    });
    const allTexts = [...new Set(
      updatedExamples.flatMap((ex) => ex.segments?.map((s) => s.text).filter((t) => t.trim().length > 0 && !/^\p{P}+$/u.test(t)) ?? [])
    )];
    if (allTexts.length > 0) {
      const { existing } = await checkTerms(language, allTexts);
      setExistingTerms(new Map(Object.entries(existing)));
    }
    handleCancelEdit();
    silentRefreshRef.current = true;
    await fetchData();
  }

  useEffect(() => {
    getFilters(language)
      .then(setFilterOptions)
      .catch(() => setFilterOptions(null));
  }, [language]);

  const fetchData = useCallback(async () => {
    const currentRequestId = ++requestIdRef.current;
    const isSilent = silentRefreshRef.current;
    silentRefreshRef.current = false;
    if (!isSilent) { setLoading(true); setError(null); }
    try {
      const filters = {
        search: debouncedSearch || undefined,
        topic: topic || undefined,
        category: category || undefined,
        level: level || undefined,
        flaggedOnly: flaggedOnly || undefined,
      };
      const data = await getWords(language, filters, page);
      if (currentRequestId !== requestIdRef.current) return; // stale response
      setResult(data);
    } catch (err) {
      if (currentRequestId !== requestIdRef.current) return; // stale response
      console.error("Failed to fetch words:", err);
      setError(err instanceof Error ? err.message : "Failed to load words");
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [language, debouncedSearch, topic, category, level, flaggedOnly, page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Silent refresh when a queued word finishes processing
  const prevRefreshSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === undefined) return;
    if (refreshSignal === prevRefreshSignalRef.current) return;
    prevRefreshSignalRef.current = refreshSignal;
    silentRefreshRef.current = true;
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  // Reset page when filters change (skip initial mount)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setPage(1);
  }, [debouncedSearch, topic, category, level, flaggedOnly]);

  // Scroll to a newly added word after fetchData completes
  useEffect(() => {
    if (!expandedId || loading || !scrollToExpandedRef.current) return;
    scrollToExpandedRef.current = false;
    requestAnimationFrame(() => {
      const el = document.getElementById(`word-${expandedId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [expandedId, loading]);

  // Clear selection whenever the visible word set changes — selection is
  // scoped to the current view, not persisted across navigation.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [language, debouncedSearch, topic, category, level, flaggedOnly, page]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-gray-700 bg-gray-800 px-3 sm:px-6 py-4">
        <div className="mb-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            &larr; {t("back")}
          </button>
          <h2 className="text-lg font-semibold text-gray-100">
            {t("browseWords")} — {language}
          </h2>
          <button
            onClick={() => setShowSmartAdd(true)}
            className="ml-auto rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
          >
            + {t("addWord")}
          </button>
        </div>

        {/* Search & Filters */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full sm:w-auto rounded-lg border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-400 focus:border-blue-400 focus:outline-none"
          />
          {filterOptions && (
            <>
              <select
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="rounded-lg border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                <option value="">{t("topic")}</option>
                {filterOptions.topics.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="rounded-lg border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                <option value="">{t("category")}</option>
                {filterOptions.categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="rounded-lg border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                <option value="">{t("level")}</option>
                {filterOptions.levels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </>
          )}
          <label className="flex items-center gap-1.5 rounded-lg border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-100 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={(e) => setFlaggedOnly(e.target.checked)}
              className="accent-amber-500"
            />
            {t("flaggedOnly")}
          </label>
        </div>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-3 border-b border-gray-700 bg-gray-800/80 px-3 sm:px-6 py-2">
          <span className="text-sm text-gray-300">
            {selectedIds.size} {t("selectedCount")}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setSelectedIds(new Set())}
              className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
            >
              {t("clearSelection")}
            </button>
            <button
              onClick={() => setShowBulkDeleteConfirm(true)}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500"
            >
              {t("deleteSelected")}
            </button>
          </div>
        </div>
      )}

      {/* Word List */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-4">
        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-red-400">{error}</p>
            <button
              onClick={fetchData}
              className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-gray-200 hover:bg-gray-600"
            >
              Retry
            </button>
          </div>
        ) : !result || result.items.length === 0 ? (
          <p className="text-gray-400">{t("noWordsFound")}</p>
        ) : (
          <>
            {(() => {
              const pageIds = result.items.map((w) => w.id);
              const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
              const somePageSelected = pageIds.some((id) => selectedIds.has(id));
              return (
                <>
                  {/* Mobile card layout */}
                  <div className="space-y-3 md:hidden">
                    {result.items.map((word) => (
                      <WordCard
                        key={word.id}
                        word={word}
                        expanded={expandedId === word.id}
                        onToggle={() => handleToggleExpand(word)}
                        isFlagged={flaggedIds.has(word.id)}
                        onToggleFlag={() => handleToggleFlag(word.id)}
                        onEdit={() => setEditingWord(word)}
                        onDelete={() => setDeletingId(word.id)}
                        onToggleSegment={handleAddSegmentWord}
                        existingTerms={expandedId === word.id ? existingTerms : new Map()}
                        busySegments={expandedId === word.id ? busySegments : new Set()}
                        segmentFlags={segmentFlags}
                        onToggleSegmentFlag={(term) => setSegmentFlags((prev) => { const next = new Map(prev); next.set(term, !(prev.get(term) ?? true)); return next; })}
                        editMode={{
                          key: editingExample,
                          segments: editSegments,
                          knownTerms: editKnownTerms,
                          pinyinIndex: editPinyinIndex,
                          onStart: handleStartEdit,
                          onCancel: handleCancelEdit,
                          onSplit: handleSplitSegment,
                          onMerge: handleMergeSegments,
                          onToggleActive: handleToggleEditSegmentActive,
                          onPinyinChange: handleEditPinyinChange,
                          onTogglePinyin: (idx) => setEditPinyinIndex(editPinyinIndex === idx ? null : idx),
                          onInsertToneChar: handleInsertToneChar,
                          onSave: handleSaveEdit,
                        }}
                        selected={selectedIds.has(word.id)}
                        onToggleSelect={() => toggleSelected(word.id)}
                        currentIsoCode={currentIsoCode}
                      />
                    ))}
                  </div>
                  {/* Desktop table layout */}
                  <table className="hidden md:table w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-700 text-gray-400">
                        <th className="pb-2 pr-3 font-medium w-8">
                          <input
                            type="checkbox"
                            aria-label="Select all on page"
                            checked={allPageSelected}
                            ref={(el) => {
                              if (el) el.indeterminate = !allPageSelected && somePageSelected;
                            }}
                            onChange={toggleSelectAllOnPage}
                            className="accent-red-500"
                          />
                        </th>
                        <th className="pb-2 pr-4 font-medium">{t("term")}</th>
                        <th className="pb-2 pr-4 font-medium">{t("definition")}</th>
                        <th className="pb-2 pr-4 font-medium">{t("category")}</th>
                        <th className="pb-2 font-medium">{t("level")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.items.map((word) => (
                        <WordRow
                          key={word.id}
                          word={word}
                          expanded={expandedId === word.id}
                          onToggle={() => handleToggleExpand(word)}
                          isFlagged={flaggedIds.has(word.id)}
                          onToggleFlag={() => handleToggleFlag(word.id)}
                          onEdit={() => setEditingWord(word)}
                          onDelete={() => setDeletingId(word.id)}
                          onToggleSegment={handleAddSegmentWord}
                          existingTerms={expandedId === word.id ? existingTerms : new Map()}
                          busySegments={expandedId === word.id ? busySegments : new Set()}
                          segmentFlags={segmentFlags}
                          onToggleSegmentFlag={(term) => setSegmentFlags((prev) => { const next = new Map(prev); next.set(term, !(prev.get(term) ?? true)); return next; })}
                          editMode={{
                            key: editingExample,
                            segments: editSegments,
                            knownTerms: editKnownTerms,
                            pinyinIndex: editPinyinIndex,
                            onStart: handleStartEdit,
                            onCancel: handleCancelEdit,
                            onSplit: handleSplitSegment,
                            onMerge: handleMergeSegments,
                            onToggleActive: handleToggleEditSegmentActive,
                            onPinyinChange: handleEditPinyinChange,
                            onTogglePinyin: (idx) => setEditPinyinIndex(editPinyinIndex === idx ? null : idx),
                            onInsertToneChar: handleInsertToneChar,
                            onSave: handleSaveEdit,
                          }}
                          selected={selectedIds.has(word.id)}
                          onToggleSelect={() => toggleSelected(word.id)}
                          currentIsoCode={currentIsoCode}
                        />
                      ))}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </>
        )}
      </div>

      {/* Modals */}
      {showSmartAdd && (
        <SmartAddWordModal
          defaultLanguage={language}
          onSave={onQueue ? () => {} : (word) => {
            setResult(prev =>
              prev
                ? {
                    ...prev,
                    items: [word, ...prev.items.filter(w => w.id !== word.id)],
                    total: prev.total + 1,
                    totalPages: Math.ceil((prev.total + 1) / prev.limit),
                  }
                : prev
            );
            silentRefreshRef.current = true;
            setShowSmartAdd(false);
            setSearch("");
            setDebouncedSearch("");
            setTopic("");
            setCategory("");
            setLevel("");
            setFlaggedOnly(false);
            setPage(1);
            setExpandedId(word.id);
            scrollToExpandedRef.current = true;
            refreshExistingTerms(word);
          }}
          onQueue={onQueue}
          onJumpToWord={(wordId, term) => {
            setShowSmartAdd(false);
            setSearch(term);
            setDebouncedSearch(term);
            setTopic("");
            setCategory("");
            setLevel("");
            setFlaggedOnly(false);
            setPage(1);
            setExpandedId(wordId);
            scrollToExpandedRef.current = true;
          }}
          onClose={() => setShowSmartAdd(false)}
        />
      )}
      {editingWord && (
        <WordFormModal
          language={language}
          word={editingWord}
          onSave={handleUpdateWord}
          onClose={() => setEditingWord(null)}
        />
      )}
      {deletingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-xl bg-gray-800 p-6 shadow-lg">
            <p className="mb-4 text-gray-300">{t("deleteWordConfirm")}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeletingId(null)}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
              >
                {t("cancel")}
              </button>
              <button
                onClick={() => handleDeleteWord(deletingId)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
              >
                {t("deleteWord")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showBulkDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-xl bg-gray-800 p-6 shadow-lg">
            <p className="mb-4 text-gray-300">
              {t("deleteSelectedConfirm")} ({selectedIds.size})
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowBulkDeleteConfirm(false)}
                disabled={bulkDeleting}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50"
              >
                {t("cancel")}
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {t("deleteSelected")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pagination */}
      {result && result.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 border-t border-gray-700 bg-gray-800 px-3 sm:px-6 py-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-40"
          >
            {t("previous")}
          </button>
          <span className="text-sm text-gray-400">
            {t("page")} {result.page} {t("of")} {result.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(result.totalPages, p + 1))}
            disabled={page >= result.totalPages}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-40"
          >
            {t("next")}
          </button>
        </div>
      )}
    </div>
  );
}

function WordCard({
  word,
  expanded,
  onToggle,
  isFlagged,
  onToggleFlag,
  onEdit,
  onDelete,
  onToggleSegment,
  existingTerms,
  busySegments,
  segmentFlags,
  onToggleSegmentFlag,
  editMode,
  selected,
  onToggleSelect,
  currentIsoCode,
}: {
  word: Word;
  currentIsoCode: string;
  expanded: boolean;
  onToggle: () => void;
  isFlagged: boolean;
  onToggleFlag: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleSegment?: (term: string, sentence: string, translation: string) => void;
  existingTerms: Map<string, string>;
  busySegments: Set<string>;
  segmentFlags: Map<string, boolean>;
  onToggleSegmentFlag: (term: string) => void;
  editMode: {
    key: string | null;
    segments: Array<{ text: string; transliteration?: string; id?: string }>;
    knownTerms: Map<string, string>;
    pinyinIndex: number | null;
    onStart: (word: Word, exampleIndex: number) => void;
    onCancel: () => void;
    onSplit: (segIndex: number) => void;
    onMerge: (segIndex: number) => void;
    onToggleActive: (segIndex: number) => void;
    onPinyinChange: (segIndex: number, value: string) => void;
    onTogglePinyin: (segIndex: number) => void;
    onInsertToneChar: (char: string) => void;
    onSave: () => void;
  };
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const { t } = useI18n();
  const { displayDefEntries, displayExEntries } = useSettings();
  const [showAllDefs, setShowAllDefs] = useState(false);
  const [showAllExamples, setShowAllExamples] = useState(false);
  const defText = word.definitions.map((m) => displayDefEntries(m.text || {}).filter(([lang]) => lang !== currentIsoCode).map(([, v]) => v).join("; ")).join(" | ");

  return (
    <div
      id={`word-${word.id}`}
      onClick={onToggle}
      className={`cursor-pointer rounded-lg border bg-gray-800 p-3 ${selected ? "border-red-500/60 ring-1 ring-red-500/40" : "border-gray-700"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={selected}
            onClick={(e) => e.stopPropagation()}
            onChange={onToggleSelect}
            aria-label="Select word"
            className="mt-1 accent-red-500"
          />
          <div>
            <span className="font-medium text-gray-100">{word.term}</span>
            {word.transliteration && (
              <span className="ml-1 text-sm text-gray-400">
                ({word.transliteration})
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {word.definitions.map((m, i) => m.partOfSpeech && (
            <span key={i} className="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300">
              {m.partOfSpeech}
            </span>
          ))}
          {word.level && (
            <span className="rounded-full bg-blue-900/40 px-2 py-0.5 text-xs text-blue-300">
              {word.level}
            </span>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-gray-300">{defText}</p>
      {expanded && (
        <div className="mt-2 rounded bg-gray-700 p-3">
          {word.definitions.length > 0 && (
            <>
              <div className="flex items-center gap-2 mb-3">
                <div className="h-px flex-1 bg-indigo-500/50"></div>
                <span className="text-xs font-semibold text-indigo-400">📖 {t("definitions")}</span>
                <div className="h-px flex-1 bg-indigo-500/50"></div>
              </div>
              <div className="space-y-2">
                {(showAllDefs ? word.definitions : word.definitions.slice(0, 3)).map((m, i) => (
                  <div key={i} className={`${i > 0 ? "border-t border-gray-600 pt-2" : ""}`}>
                    {m.partOfSpeech && (
                      <span className="mr-2 rounded-full bg-gray-600 px-2 py-0.5 text-xs text-gray-300">
                        {m.partOfSpeech}
                      </span>
                    )}
                    <div className="mt-1 space-y-0.5">
                      {displayDefEntries(m.text || {}).filter(([lang]) => lang !== currentIsoCode).map(([lang, def]) => (
                        <p key={lang} className="text-sm text-gray-300">
                          <span className="mr-1.5 text-xs font-medium uppercase text-gray-500">{lang}</span>
                          {def}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {word.definitions.length > 3 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setShowAllDefs(!showAllDefs); }}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-md border border-gray-600 bg-gray-600/30 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600/60 hover:text-gray-100 transition-colors"
                >
                  {showAllDefs ? "▲ Show less" : `▼ Show ${word.definitions.length - 3} more definitions`}
                </button>
              )}
            </>
          )}
          {word.examples.length > 0 && (
            <div className={word.definitions.length > 0 ? "mt-3" : ""}>
              <div className="flex items-center gap-2 mb-3">
                <div className="h-px flex-1 bg-teal-500/50"></div>
                <span className="text-xs font-semibold text-teal-400">💬 {t("examples")}</span>
                <div className="h-px flex-1 bg-teal-500/50"></div>
              </div>
              <ul className="space-y-2">
                {(showAllExamples ? word.examples : word.examples.slice(0, 3)).map((ex, i) => {
                  const trans = typeof ex.translation === "string" ? ex.translation : displayTranslation(ex.translation);
                  const segs = (ex.segments ?? []).filter((s) => s.text.trim().length > 0 && !/^\p{P}+$/u.test(s.text));
                  const exEntries: [string, string][] = typeof ex.translation === "object" && ex.translation
                    ? displayExEntries(ex.translation).filter(([lang]) => lang !== currentIsoCode)
                    : typeof ex.translation === "string" && ex.translation
                      ? [["", ex.translation]]
                      : [];
                  return (
                    <li key={i} className="text-base text-gray-300">
                      <span><RubyText text={ex.sentence} segments={ex.segments} /></span>
                      {exEntries.length > 0 && (
                        <div className="ml-2 mt-0.5 space-y-0.5">
                          {exEntries.map(([lang, text]) => (
                            <p key={lang || text} className="text-sm text-gray-400">
                              {lang && <span className="mr-1.5 text-xs font-medium uppercase text-gray-500">{lang}</span>}
                              {text}
                            </p>
                          ))}
                        </div>
                      )}
                      {editMode.key === `${word.id}:${i}` ? (
                        <div className="mt-1 space-y-2">
                          <div className="flex flex-wrap gap-0.5 items-end">
                            {editMode.segments.flatMap((seg, j) => {
                              const isActivated = !!seg.id;
                              const isKnown = editMode.knownTerms.has(seg.text);
                              const isPunct = /^\p{P}+$/u.test(seg.text) || seg.text.trim().length === 0;
                              const canSplit = !isActivated && !isPunct && Array.from(seg.text).length > 1;
                              const prev = j > 0 ? editMode.segments[j - 1] : null;
                              const prevEditable = prev && !prev.id && !/^\p{P}+$/u.test(prev.text) && prev.text.trim().length > 0;
                              const thisEditable = !isActivated && !isPunct;
                              const els: React.ReactNode[] = [];
                              if (prevEditable && thisEditable) {
                                els.push(
                                  <button key={`m${j}`} onClick={(e) => { e.stopPropagation(); editMode.onMerge(j - 1); }} className="rounded bg-yellow-800/30 border border-yellow-500/40 text-yellow-400 hover:bg-yellow-700/40 hover:text-yellow-300 text-[10px] px-1 py-0 leading-4 self-center" title="Merge">+</button>
                                );
                              }
                              els.push(
                                <div key={`s${j}`} className="flex flex-col items-center">
                                  <span
                                    className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                                      isPunct ? "text-gray-600 cursor-default"
                                      : isActivated ? "border border-green-500/40 bg-green-900/20 text-green-300"
                                      : isKnown ? "border border-blue-500/40 bg-blue-900/20 text-blue-300"
                                      : canSplit ? "border border-yellow-500/40 bg-yellow-900/20 text-yellow-300"
                                      : "border border-gray-500/40 bg-gray-800/30 text-gray-300"
                                    }`}
                                    title={isActivated ? "Activated" : isKnown ? "Known inactive" : canSplit ? "Unknown" : undefined}
                                  >
                                    {seg.text}
                                  </span>
                                  {!isPunct && (
                                    <div className="mt-0.5 flex gap-1">
                                      {isActivated ? (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); editMode.onToggleActive(j); }}
                                          className="text-[10px] text-red-300 hover:text-red-200"
                                          title="Deactivate"
                                        >
                                          deactivate
                                        </button>
                                      ) : isKnown ? (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); editMode.onToggleActive(j); }}
                                          className="text-[10px] text-green-300 hover:text-green-200"
                                          title="Activate"
                                        >
                                          activate
                                        </button>
                                      ) : null}
                                      {canSplit && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); editMode.onSplit(j); }}
                                          className="text-[10px] text-yellow-400 hover:text-yellow-300"
                                          title="Split"
                                        >
                                          split
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {!isPunct && (
                                    <button
                                      disabled={isActivated}
                                      onClick={(e) => { e.stopPropagation(); if (!isActivated) editMode.onTogglePinyin(j); }}
                                      className={`text-[10px] mt-0.5 ${
                                        isActivated ? "text-gray-600 cursor-default"
                                        : editMode.pinyinIndex === j ? "text-blue-400"
                                        : "text-gray-500 hover:text-gray-300 cursor-pointer"
                                      }`}
                                    >
                                      {seg.transliteration || "—"}
                                    </button>
                                  )}
                                </div>
                              );
                              return els;
                            })}
                            <button onClick={(e) => { e.stopPropagation(); editMode.onSave(); }} className="ml-2 rounded px-2 py-0.5 text-xs border border-green-500/40 text-green-400 hover:bg-green-900/30 self-center" title="Save">✓</button>
                            <button onClick={(e) => { e.stopPropagation(); editMode.onCancel(); }} className="rounded px-2 py-0.5 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-700/30 self-center" title="Cancel">✗</button>
                          </div>
                          {editMode.pinyinIndex !== null && (() => {
                            const ps = editMode.segments[editMode.pinyinIndex];
                            if (!ps || ps.id) return null;
                            return (
                              <div className="flex flex-col gap-1 pl-1" onClick={(e) => e.stopPropagation()}>
                                <input
                                  id="pinyin-edit-input"
                                  type="text"
                                  value={ps.transliteration ?? ""}
                                  onChange={(e) => editMode.onPinyinChange(editMode.pinyinIndex!, e.target.value)}
                                  className="w-40 rounded bg-gray-800 border border-gray-600 px-2 py-0.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                                  autoFocus
                                />
                                <div className="flex flex-wrap gap-0.5">
                                  {"āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ".split("").map((ch) => (
                                    <button key={ch} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); editMode.onInsertToneChar(ch); }} className="rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300 hover:bg-gray-600">{ch}</button>
                                  ))}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      ) : onToggleSegment && segs.length > 0 ? (
                        <div className="mt-1 space-y-0.5">
                          {/* Segment buttons row */}
                          <div className="flex flex-wrap gap-1 items-center">
                            {segs.map((seg, j) => {
                              const isSelf = seg.text === word.term;
                              const exists = isSelf || existingTerms.has(seg.text);
                              const busy = busySegments.has(seg.text);
                              return (
                                <button
                                  key={j}
                                  disabled={busy || exists}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!exists) onToggleSegment(seg.text, ex.sentence, trans);
                                  }}
                                  className={`rounded-full px-2 py-0.5 text-xs transition-colors ${busy ? "opacity-50 cursor-wait" : ""} ${
                                    isSelf
                                      ? "border border-gray-500/40 bg-gray-800/40 text-gray-500 cursor-default"
                                      : exists
                                        ? "border border-green-500/40 bg-green-900/20 text-green-300 cursor-default"
                                        : "border border-blue-500/40 bg-blue-900/20 text-blue-300 hover:bg-blue-800/40"
                                  }`}
                                >
                                  {exists ? "" : "+"} {seg.text}
                                </button>
                              );
                            })}
                            <button
                              onClick={(e) => { e.stopPropagation(); editMode.onStart(word, i); }}
                              className="rounded-full px-2 py-0.5 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-700/40 transition-colors"
                              title="Edit segments"
                            >
                              ✎
                            </button>
                          </div>
                          {/* Flag checkboxes row — only if some segments are deactivated */}
                          {segs.some((seg) => seg.text !== word.term && !existingTerms.has(seg.text)) && (
                            <div className="flex flex-wrap gap-1 items-center">
                              {segs.map((seg, j) => {
                                const isSelf = seg.text === word.term;
                                const exists = isSelf || existingTerms.has(seg.text);
                                const flagged = segmentFlags.get(seg.text) ?? true;
                                return (
                                  <span key={j} className="inline-flex justify-center" style={{ width: `${seg.text.length * 0.75 + 1.5}em`, minWidth: "fit-content" }}>
                                    {!isSelf && !exists && (
                                      <label className="flex items-center gap-0.5 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                        <input
                                          type="checkbox"
                                          checked={flagged}
                                          onChange={() => onToggleSegmentFlag(seg.text)}
                                          className="accent-amber-500 w-3 h-3"
                                          aria-label={`Flag ${seg.text} for review`}
                                        />
                                      </label>
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : onToggleSegment ? (
                        <div className="mt-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); editMode.onStart(word, i); }}
                            className="rounded-full px-2 py-0.5 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-700/40 transition-colors"
                            title="Edit segments"
                          >
                            ✎
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {word.examples.length > 3 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setShowAllExamples(!showAllExamples); }}
                  className="mt-1.5 text-xs text-gray-400 hover:text-gray-200 underline"
                >
                  {showAllExamples ? "Show less" : `+ ${word.examples.length - 3} more examples`}
                </button>
              )}
            </div>
          )}
          {word.topics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {word.topics.map((tp) => (
                <span
                  key={tp}
                  className="rounded-full bg-blue-900/40 px-2 py-0.5 text-xs text-blue-300"
                >
                  {tp}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFlag(); }}
              className={`rounded px-2 py-1 text-xs ${isFlagged ? "bg-amber-600 text-white hover:bg-amber-500" : "bg-gray-600 text-gray-200 hover:bg-gray-500"}`}
            >
              {isFlagged ? t("removeFlag") : t("flagForReview")}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="rounded bg-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-500"
            >
              {t("editWord")}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="rounded bg-red-700 px-2 py-1 text-xs text-gray-200 hover:bg-red-600"
            >
              {t("deleteWord")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WordRow({
  word,
  expanded,
  onToggle,
  isFlagged,
  onToggleFlag,
  onEdit,
  onDelete,
  onToggleSegment,
  existingTerms,
  busySegments,
  segmentFlags,
  onToggleSegmentFlag,
  editMode,
  selected,
  onToggleSelect,
  currentIsoCode,
}: {
  word: Word;
  currentIsoCode: string;
  expanded: boolean;
  onToggle: () => void;
  isFlagged: boolean;
  onToggleFlag: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleSegment?: (term: string, sentence: string, translation: string) => void;
  existingTerms: Map<string, string>;
  busySegments: Set<string>;
  segmentFlags: Map<string, boolean>;
  onToggleSegmentFlag: (term: string) => void;
  editMode: {
    key: string | null;
    segments: Array<{ text: string; transliteration?: string; id?: string }>;
    knownTerms: Map<string, string>;
    pinyinIndex: number | null;
    onStart: (word: Word, exampleIndex: number) => void;
    onCancel: () => void;
    onSplit: (segIndex: number) => void;
    onMerge: (segIndex: number) => void;
    onToggleActive: (segIndex: number) => void;
    onPinyinChange: (segIndex: number, value: string) => void;
    onTogglePinyin: (segIndex: number) => void;
    onInsertToneChar: (char: string) => void;
    onSave: () => void;
  };
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const { t } = useI18n();
  const { displayDefEntries, displayExEntries } = useSettings();
  const [showAllDefs, setShowAllDefs] = useState(false);
  const [showAllExamples, setShowAllExamples] = useState(false);
  const defText = word.definitions.map((m) => displayDefEntries(m.text || {}).filter(([lang]) => lang !== currentIsoCode).map(([, v]) => v).join("; ")).join(" | ");

  return (
    <>
      <tr
        id={`word-${word.id}`}
        onClick={onToggle}
        className={`cursor-pointer border-b border-gray-700 hover:bg-gray-700 ${selected ? "bg-red-900/20" : ""}`}
      >
        <td className="py-2 pr-3 w-8" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label="Select word"
            className="accent-red-500"
          />
        </td>
        <td className="py-2 pr-4">
          <span className="font-medium text-gray-100">{word.term}</span>
          {word.transliteration && (
            <span className="ml-1 text-sm text-gray-400">
              ({word.transliteration})
            </span>
          )}
        </td>
        <td className="py-2 pr-4 text-gray-300">{defText}</td>
        <td className="py-2 pr-4 text-gray-400">{[...new Set(word.definitions.map((m) => m.partOfSpeech).filter(Boolean))].join(", ")}</td>
        <td className="py-2 text-gray-400">{word.level ?? "—"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="bg-gray-700 px-4 py-3">
            {word.definitions.length > 0 && (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1 bg-indigo-500/50"></div>
                  <span className="text-xs font-semibold text-indigo-400">📖 {t("definitions")}</span>
                  <div className="h-px flex-1 bg-indigo-500/50"></div>
                </div>
                <div className="space-y-2">
                  {(showAllDefs ? word.definitions : word.definitions.slice(0, 3)).map((m, i) => (
                    <div key={i} className={`${i > 0 ? "border-t border-gray-600 pt-2" : ""}`}>
                      {m.partOfSpeech && (
                        <span className="mr-2 rounded-full bg-gray-600 px-2 py-0.5 text-xs text-gray-300">
                          {m.partOfSpeech}
                        </span>
                      )}
                      <div className="mt-1 space-y-0.5">
                        {displayDefEntries(m.text || {}).filter(([lang]) => lang !== currentIsoCode).map(([lang, def]) => (
                          <p key={lang} className="text-sm text-gray-300">
                            <span className="mr-1.5 text-xs font-medium uppercase text-gray-500">{lang}</span>
                            {def}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {word.definitions.length > 3 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowAllDefs(!showAllDefs); }}
                    className="mt-1.5 text-xs text-gray-400 hover:text-gray-200 underline"
                  >
                    {showAllDefs ? "Show less" : `+ ${word.definitions.length - 3} more definitions`}
                  </button>
                )}
              </>
            )}
            {word.examples.length > 0 && (
              <div className={word.definitions.length > 0 ? "mt-3" : ""}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1 bg-teal-500/50"></div>
                  <span className="text-xs font-semibold text-teal-400">💬 {t("examples")}</span>
                  <div className="h-px flex-1 bg-teal-500/50"></div>
                </div>
                <ul className="space-y-2">
                  {(showAllExamples ? word.examples : word.examples.slice(0, 3)).map((ex, i) => {
                    const trans = typeof ex.translation === "string" ? ex.translation : displayTranslation(ex.translation);
                    const segs = (ex.segments ?? []).filter((s) => s.text.trim().length > 0 && !/^\p{P}+$/u.test(s.text));
                    const exEntries: [string, string][] = typeof ex.translation === "object" && ex.translation
                      ? displayExEntries(ex.translation).filter(([lang]) => lang !== currentIsoCode)
                      : typeof ex.translation === "string" && ex.translation
                        ? [["", ex.translation]]
                        : [];
                    return (
                      <li key={i} className="text-base text-gray-300">
                        <span><RubyText text={ex.sentence} segments={ex.segments} /></span>
                        {exEntries.length > 0 && (
                          <div className="ml-2 mt-0.5 space-y-0.5">
                            {exEntries.map(([lang, text]) => (
                              <p key={lang || text} className="text-sm text-gray-400">
                                {lang && <span className="mr-1.5 text-xs font-medium uppercase text-gray-500">{lang}</span>}
                                {text}
                              </p>
                            ))}
                          </div>
                        )}
                        {editMode.key === `${word.id}:${i}` ? (
                          <div className="mt-1 space-y-2">
                            <div className="flex flex-wrap gap-0.5 items-end">
                            {editMode.segments.flatMap((seg, j) => {
                                const isActivated = !!seg.id;
                                const isKnown = editMode.knownTerms.has(seg.text);
                                const isPunct = /^\p{P}+$/u.test(seg.text) || seg.text.trim().length === 0;
                                const canSplit = !isActivated && !isPunct && Array.from(seg.text).length > 1;
                                const prev = j > 0 ? editMode.segments[j - 1] : null;
                                const prevEditable = prev && !prev.id && !/^\p{P}+$/u.test(prev.text) && prev.text.trim().length > 0;
                                const thisEditable = !isActivated && !isPunct;
                                const els: React.ReactNode[] = [];
                                if (prevEditable && thisEditable) {
                                  els.push(
                                    <button key={`m${j}`} onClick={(e) => { e.stopPropagation(); editMode.onMerge(j - 1); }} className="rounded bg-yellow-800/30 border border-yellow-500/40 text-yellow-400 hover:bg-yellow-700/40 hover:text-yellow-300 text-[10px] px-1 py-0 leading-4 self-center" title="Merge">+</button>
                                  );
                                }
                                els.push(
                                  <div key={`s${j}`} className="flex flex-col items-center">
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                                        isPunct ? "text-gray-600 cursor-default"
                                        : isActivated ? "border border-green-500/40 bg-green-900/20 text-green-300"
                                        : isKnown ? "border border-blue-500/40 bg-blue-900/20 text-blue-300"
                                        : canSplit ? "border border-yellow-500/40 bg-yellow-900/20 text-yellow-300"
                                        : "border border-gray-500/40 bg-gray-800/30 text-gray-300"
                                      }`}
                                      title={isActivated ? "Activated" : isKnown ? "Known inactive" : canSplit ? "Unknown" : undefined}
                                    >
                                      {seg.text}
                                    </span>
                                    {!isPunct && (
                                      <div className="mt-0.5 flex gap-1">
                                        {isActivated ? (
                                          <button
                                            onClick={(e) => { e.stopPropagation(); editMode.onToggleActive(j); }}
                                            className="text-[10px] text-red-300 hover:text-red-200"
                                            title="Deactivate"
                                          >
                                            deactivate
                                          </button>
                                        ) : isKnown ? (
                                          <button
                                            onClick={(e) => { e.stopPropagation(); editMode.onToggleActive(j); }}
                                            className="text-[10px] text-green-300 hover:text-green-200"
                                            title="Activate"
                                          >
                                            activate
                                          </button>
                                        ) : null}
                                        {canSplit && (
                                          <button
                                            onClick={(e) => { e.stopPropagation(); editMode.onSplit(j); }}
                                            className="text-[10px] text-yellow-400 hover:text-yellow-300"
                                            title="Split"
                                          >
                                            split
                                          </button>
                                        )}
                                      </div>
                                    )}
                                    {!isPunct && (
                                      <button
                                        disabled={isActivated}
                                        onClick={(e) => { e.stopPropagation(); if (!isActivated) editMode.onTogglePinyin(j); }}
                                        className={`text-[10px] mt-0.5 ${
                                          isActivated ? "text-gray-600 cursor-default"
                                          : editMode.pinyinIndex === j ? "text-blue-400"
                                          : "text-gray-500 hover:text-gray-300 cursor-pointer"
                                        }`}
                                      >
                                        {seg.transliteration || "—"}
                                      </button>
                                    )}
                                  </div>
                                );
                                return els;
                              })}
                              <button onClick={(e) => { e.stopPropagation(); editMode.onSave(); }} className="ml-2 rounded px-2 py-0.5 text-xs border border-green-500/40 text-green-400 hover:bg-green-900/30 self-center" title="Save">✓</button>
                              <button onClick={(e) => { e.stopPropagation(); editMode.onCancel(); }} className="rounded px-2 py-0.5 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-700/30 self-center" title="Cancel">✗</button>
                            </div>
                            {editMode.pinyinIndex !== null && (() => {
                              const ps = editMode.segments[editMode.pinyinIndex];
                              if (!ps || ps.id) return null;
                              return (
                                <div className="flex flex-col gap-1 pl-1" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    id="pinyin-edit-input"
                                    type="text"
                                    value={ps.transliteration ?? ""}
                                    onChange={(e) => editMode.onPinyinChange(editMode.pinyinIndex!, e.target.value)}
                                    className="w-40 rounded bg-gray-800 border border-gray-600 px-2 py-0.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                                    autoFocus
                                  />
                                  <div className="flex flex-wrap gap-0.5">
                                    {"āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ".split("").map((ch) => (
                                      <button key={ch} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); editMode.onInsertToneChar(ch); }} className="rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300 hover:bg-gray-600">{ch}</button>
                                    ))}
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        ) : onToggleSegment && segs.length > 0 ? (
                          <div className="mt-1 space-y-0.5">
                            {/* Segment buttons row */}
                            <div className="flex flex-wrap gap-1 items-center">
                              {segs.map((seg, j) => {
                                const isSelf = seg.text === word.term;
                              const exists = isSelf || existingTerms.has(seg.text);
                              const busy = busySegments.has(seg.text);
                              return (
                                <button
                                  key={j}
                                    disabled={busy || exists}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!exists) onToggleSegment(seg.text, ex.sentence, trans);
                                    }}
                                  className={`rounded-full px-2 py-0.5 text-xs transition-colors ${busy ? "opacity-50 cursor-wait" : ""} ${
                                    isSelf
                                      ? "border border-gray-500/40 bg-gray-800/40 text-gray-500 cursor-default"
                                      : exists
                                          ? "border border-green-500/40 bg-green-900/20 text-green-300 cursor-default"
                                          : "border border-blue-500/40 bg-blue-900/20 text-blue-300 hover:bg-blue-800/40"
                                  }`}
                                  >
                                    {exists ? "" : "+"} {seg.text}
                                  </button>
                                );
                              })}
                              <button
                                onClick={(e) => { e.stopPropagation(); editMode.onStart(word, i); }}
                                className="rounded-full px-2 py-0.5 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-700/40 transition-colors"
                                title="Edit segments"
                              >
                                ✎
                              </button>
                            </div>
                            {/* Flag checkboxes row — only if some segments are deactivated */}
                            {segs.some((seg) => seg.text !== word.term && !existingTerms.has(seg.text)) && (
                              <div className="flex flex-wrap gap-1 items-center">
                                {segs.map((seg, j) => {
                                  const isSelf = seg.text === word.term;
                                  const exists = isSelf || existingTerms.has(seg.text);
                                  const flagged = segmentFlags.get(seg.text) ?? true;
                                  return (
                                    <span key={j} className="inline-flex justify-center" style={{ width: `${seg.text.length * 0.75 + 1.5}em`, minWidth: "fit-content" }}>
                                      {!isSelf && !exists && (
                                        <label className="flex items-center gap-0.5 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                          <input
                                            type="checkbox"
                                            checked={flagged}
                                            onChange={() => onToggleSegmentFlag(seg.text)}
                                            className="accent-amber-500 w-3 h-3"
                                            aria-label={`Flag ${seg.text} for review`}
                                          />
                                        </label>
                                      )}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ) : onToggleSegment ? (
                          <div className="mt-1">
                            <button
                              onClick={(e) => { e.stopPropagation(); editMode.onStart(word, i); }}
                              className="rounded-full px-2 py-0.5 text-xs border border-gray-500/40 text-gray-400 hover:bg-gray-700/40 transition-colors"
                              title="Edit segments"
                            >
                              ✎
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {word.examples.length > 3 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowAllExamples(!showAllExamples); }}
                    className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-md border border-gray-600 bg-gray-600/30 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600/60 hover:text-gray-100 transition-colors"
                  >
                    {showAllExamples ? "▲ Show less" : `▼ Show ${word.examples.length - 3} more examples`}
                  </button>
                )}
              </div>
            )}
            {word.topics.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {word.topics.map((tp) => (
                  <span
                    key={tp}
                    className="rounded-full bg-blue-900/40 px-2 py-0.5 text-xs text-blue-300"
                  >
                    {tp}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); onToggleFlag(); }}
                className={`rounded px-2 py-1 text-xs ${isFlagged ? "bg-amber-600 text-white hover:bg-amber-500" : "bg-gray-600 text-gray-200 hover:bg-gray-500"}`}
              >
                {isFlagged ? t("removeFlag") : t("flagForReview")}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="rounded bg-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-500"
              >
                {t("editWord")}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="rounded bg-red-700 px-2 py-1 text-xs text-gray-200 hover:bg-red-600"
              >
                {t("deleteWord")}
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
