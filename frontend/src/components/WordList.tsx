import { useEffect, useState, useCallback, useRef } from "react";
import { useI18n } from "../i18n/context";
import { getWords, getFilters, getTransliterationMap, updateWord, deleteWord } from "../api/vocab";
import { getFlaggedWords, flagWord as apiFlagWord, unflagWord as apiUnflagWord } from "../api/flagged";
import RubyText from "./RubyText";
import WordFormModal from "./WordFormModal";
import SmartAddWordModal from "./SmartAddWordModal";
import { displayTranslation, type Word, type PaginatedResult } from "../types";

interface Props {
  language: string;
  onBack: () => void;
  transliterationMap?: Record<string, string>;
}

export default function WordList({ language, onBack, transliterationMap: externalMap }: Props) {
  const { t } = useI18n();
  const [result, setResult] = useState<PaginatedResult<Word> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [topic, setTopic] = useState("");
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<{
    topics: string[];
    categories: string[];
    levels: string[];
  } | null>(null);
  const [transliterationMap, setTransliterationMap] = useState<Record<string, string>>(externalMap ?? {});
  const [showSmartAdd, setShowSmartAdd] = useState(false);
  const [editingWord, setEditingWord] = useState<Word | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const isInitialMount = useRef(true);
  const requestIdRef = useRef(0);

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
    getTransliterationMap(language).then(setTransliterationMap).catch(() => {});
  }

  async function handleDeleteWord(wordId: string) {
    await deleteWord(language, wordId);
    setDeletingId(null);
    setExpandedId(null);
    await fetchData();
    getTransliterationMap(language).then(setTransliterationMap).catch(() => {});
  }

  useEffect(() => {
    if (externalMap) setTransliterationMap(externalMap);
  }, [externalMap]);

  useEffect(() => {
    getFilters(language)
      .then(setFilterOptions)
      .catch(() => setFilterOptions(null));
    if (!externalMap) {
      getTransliterationMap(language)
        .then(setTransliterationMap)
        .catch(() => setTransliterationMap({}));
    }
  }, [language, externalMap]);

  const fetchData = useCallback(async () => {
    const currentRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
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

  // Reset page when filters change (skip initial mount)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setPage(1);
  }, [debouncedSearch, topic, category, level, flaggedOnly]);

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
            {/* Mobile card layout */}
            <div className="space-y-3 md:hidden">
              {result.items.map((word) => (
                <WordCard
                  key={word.id}
                  word={word}
                  expanded={expandedId === word.id}
                  onToggle={() =>
                    setExpandedId(expandedId === word.id ? null : word.id)
                  }
                  transliterationMap={transliterationMap}
                  isFlagged={flaggedIds.has(word.id)}
                  onToggleFlag={() => handleToggleFlag(word.id)}
                  onEdit={() => setEditingWord(word)}
                  onDelete={() => setDeletingId(word.id)}
                />
              ))}
            </div>
            {/* Desktop table layout */}
            <table className="hidden md:table w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-700 text-gray-400">
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
                    onToggle={() =>
                      setExpandedId(expandedId === word.id ? null : word.id)
                    }
                    transliterationMap={transliterationMap}
                    isFlagged={flaggedIds.has(word.id)}
                    onToggleFlag={() => handleToggleFlag(word.id)}
                    onEdit={() => setEditingWord(word)}
                    onDelete={() => setDeletingId(word.id)}
                  />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Modals */}
      {showSmartAdd && (
        <SmartAddWordModal
          onSave={() => { setShowSmartAdd(false); fetchData(); }}
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
  transliterationMap,
  isFlagged,
  onToggleFlag,
  onEdit,
  onDelete,
}: {
  word: Word;
  expanded: boolean;
  onToggle: () => void;
  transliterationMap: Record<string, string>;
  isFlagged: boolean;
  onToggleFlag: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const defText = Object.values(word.definition).join("; ");

  return (
    <div
      onClick={onToggle}
      className="cursor-pointer rounded-lg border border-gray-700 bg-gray-800 p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-medium text-gray-100">{word.term}</span>
          {word.transliteration && (
            <span className="ml-1 text-sm text-gray-400">
              ({word.transliteration})
            </span>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {word.grammaticalCategory && (
            <span className="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300">
              {word.grammaticalCategory}
            </span>
          )}
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
          {word.examples.length > 0 && (
            <>
              <p className="mb-1 text-xs font-medium text-gray-400">
                {t("examples")}
              </p>
              <ul className="space-y-1">
                {word.examples.map((ex, i) => (
                  <li key={i} className="text-base text-gray-300">
                    <span><RubyText text={ex.sentence} transliterationMap={transliterationMap} segments={ex.segments} /></span>
                    <span className="ml-2 text-gray-400">— {displayTranslation(ex.translation)}</span>
                  </li>
                ))}
              </ul>
            </>
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
  transliterationMap,
  isFlagged,
  onToggleFlag,
  onEdit,
  onDelete,
}: {
  word: Word;
  expanded: boolean;
  onToggle: () => void;
  transliterationMap: Record<string, string>;
  isFlagged: boolean;
  onToggleFlag: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const defText = Object.values(word.definition).join("; ");

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-gray-700 hover:bg-gray-700"
      >
        <td className="py-2 pr-4">
          <span className="font-medium text-gray-100">{word.term}</span>
          {word.transliteration && (
            <span className="ml-1 text-sm text-gray-400">
              ({word.transliteration})
            </span>
          )}
        </td>
        <td className="py-2 pr-4 text-gray-300">{defText}</td>
        <td className="py-2 pr-4 text-gray-400">{word.grammaticalCategory}</td>
        <td className="py-2 text-gray-400">{word.level ?? "—"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} className="bg-gray-700 px-4 py-3">
            {word.examples.length > 0 && (
              <>
                <p className="mb-1 text-xs font-medium text-gray-400">
                  {t("examples")}
                </p>
                <ul className="space-y-1">
                  {word.examples.map((ex, i) => (
                    <li key={i} className="text-base text-gray-300">
                      <span><RubyText text={ex.sentence} transliterationMap={transliterationMap} segments={ex.segments} /></span>
                      <span className="ml-2 text-gray-400">— {displayTranslation(ex.translation)}</span>
                    </li>
                  ))}
                </ul>
              </>
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
