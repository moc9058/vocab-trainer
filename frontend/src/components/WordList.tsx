import { useEffect, useState, useCallback } from "react";
import { useI18n } from "../i18n/context";
import { getWords, getFilters, getPinyinMap } from "../api/vocab";
import RubyText from "./RubyText";
import type { Word, PaginatedResult } from "../types";

interface Props {
  language: string;
  onBack: () => void;
  pinyinMap?: Record<string, string>;
}

export default function WordList({ language, onBack, pinyinMap: externalMap }: Props) {
  const { t } = useI18n();
  const [result, setResult] = useState<PaginatedResult<Word> | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [topic, setTopic] = useState("");
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<{
    topics: string[];
    categories: string[];
    levels: string[];
  } | null>(null);
  const [pinyinMap, setPinyinMap] = useState<Record<string, string>>(externalMap ?? {});

  useEffect(() => {
    if (externalMap) setPinyinMap(externalMap);
  }, [externalMap]);

  useEffect(() => {
    getFilters(language)
      .then(setFilterOptions)
      .catch(() => setFilterOptions(null));
    if (!externalMap) {
      getPinyinMap(language)
        .then(setPinyinMap)
        .catch(() => setPinyinMap({}));
    }
  }, [language, externalMap]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const filters = {
        search: search || undefined,
        topic: topic || undefined,
        category: category || undefined,
        level: level || undefined,
      };
      const data = await getWords(language, filters, page);
      setResult(data);
    } catch (err) {
      console.error("Failed to fetch words:", err);
    } finally {
      setLoading(false);
    }
  }, [language, search, topic, category, level, page]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [search, topic, category, level]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white px-3 sm:px-6 py-4">
        <div className="mb-3 flex items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            &larr; {t("back")}
          </button>
          <h2 className="text-lg font-semibold text-gray-800">
            {t("browseWords")} — {language}
          </h2>
        </div>

        {/* Search & Filters */}
        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full sm:w-auto rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
          />
          {filterOptions && (
            <>
              <select
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
              >
                <option value="">{t("topic")}</option>
                {filterOptions.topics.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
              >
                <option value="">{t("category")}</option>
                {filterOptions.categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
              >
                <option value="">{t("level")}</option>
                {filterOptions.levels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>

      {/* Word List */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-4">
        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : !result || result.items.length === 0 ? (
          <p className="text-gray-500">{t("noWordsFound")}</p>
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
                  pinyinMap={pinyinMap}
                />
              ))}
            </div>
            {/* Desktop table layout */}
            <table className="hidden md:table w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500">
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
                    pinyinMap={pinyinMap}
                  />
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Pagination */}
      {result && result.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 border-t border-gray-200 bg-white px-3 sm:px-6 py-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40"
          >
            {t("previous")}
          </button>
          <span className="text-sm text-gray-500">
            {t("page")} {result.page} {t("of")} {result.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(result.totalPages, p + 1))}
            disabled={page >= result.totalPages}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40"
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
  pinyinMap,
}: {
  word: Word;
  expanded: boolean;
  onToggle: () => void;
  pinyinMap: Record<string, string>;
}) {
  const { t } = useI18n();
  const defText = Object.values(word.definition).join("; ");

  return (
    <div
      onClick={onToggle}
      className="cursor-pointer rounded-lg border border-gray-200 bg-white p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-medium text-gray-800">{word.term}</span>
          {word.transliteration && (
            <span className="ml-1 text-sm text-gray-400">
              ({word.transliteration})
            </span>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {word.grammaticalCategory && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
              {word.grammaticalCategory}
            </span>
          )}
          {word.level && (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
              {word.level}
            </span>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-gray-600">{defText}</p>
      {expanded && word.examples.length > 0 && (
        <div className="mt-2 rounded bg-gray-50 p-3">
          <p className="mb-1 text-xs font-medium text-gray-500">
            {t("examples")}
          </p>
          <ul className="space-y-1">
            {word.examples.map((ex, i) => (
              <li key={i} className="text-base text-gray-600">
                <span><RubyText text={ex.sentence} pinyinMap={pinyinMap} segments={ex.segments} /></span>
                <span className="ml-2 text-gray-400">— {ex.translation}</span>
              </li>
            ))}
          </ul>
          {word.topics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {word.topics.map((tp) => (
                <span
                  key={tp}
                  className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700"
                >
                  {tp}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WordRow({
  word,
  expanded,
  onToggle,
  pinyinMap,
}: {
  word: Word;
  expanded: boolean;
  onToggle: () => void;
  pinyinMap: Record<string, string>;
}) {
  const { t } = useI18n();
  const defText = Object.values(word.definition).join("; ");

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
      >
        <td className="py-2 pr-4">
          <span className="font-medium text-gray-800">{word.term}</span>
          {word.transliteration && (
            <span className="ml-1 text-sm text-gray-400">
              ({word.transliteration})
            </span>
          )}
        </td>
        <td className="py-2 pr-4 text-gray-600">{defText}</td>
        <td className="py-2 pr-4 text-gray-500">{word.grammaticalCategory}</td>
        <td className="py-2 text-gray-500">{word.level ?? "—"}</td>
      </tr>
      {expanded && word.examples.length > 0 && (
        <tr>
          <td colSpan={4} className="bg-gray-50 px-4 py-3">
            <p className="mb-1 text-xs font-medium text-gray-500">
              {t("examples")}
            </p>
            <ul className="space-y-1">
              {word.examples.map((ex, i) => (
                <li key={i} className="text-base text-gray-600">
                  <span><RubyText text={ex.sentence} pinyinMap={pinyinMap} segments={ex.segments} /></span>
                  <span className="ml-2 text-gray-400">— {ex.translation}</span>
                </li>
              ))}
            </ul>
            {word.topics.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {word.topics.map((tp) => (
                  <span
                    key={tp}
                    className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700"
                  >
                    {tp}
                  </span>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
