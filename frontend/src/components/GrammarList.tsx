import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../i18n/context";
import { getGrammarChapters, getGrammarItems, deleteGrammarItem } from "../api/grammar";
import { displayTranslation, type GrammarChapterInfo, type GrammarItemDoc } from "../types";
import GrammarFormModal from "./GrammarFormModal";

interface Props {
  language: string;
  onBack: () => void;
}

export default function GrammarList({ language, onBack }: Props) {
  const { t, language: uiLang } = useI18n();
  const [chapters, setChapters] = useState<GrammarChapterInfo[]>([]);
  const [items, setItems] = useState<GrammarItemDoc[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<GrammarItemDoc | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    getGrammarChapters(language)
      .then(setChapters)
      .catch(() => setChapters([]))
      .finally(() => setLoading(false));
  }, [language]);

  const fetchItems = useCallback(() => {
    setLoading(true);
    getGrammarItems(
      language,
      { chapter: selectedChapter ?? undefined, search: search || undefined },
      page,
      20
    )
      .then((result) => {
        setItems(result.items);
        setTotalPages(result.totalPages);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [language, selectedChapter, search, page]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  async function handleDelete(componentId: string) {
    try {
      await deleteGrammarItem(language, componentId);
      setDeletingId(null);
      fetchItems();
    } catch {
      // keep dialog open on error
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-100">{t("grammarBrowse")}</h2>
        <button
          onClick={onBack}
          className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
        >
          {t("back")}
        </button>
      </div>

      {/* Chapter filter tabs */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => { setSelectedChapter(null); setPage(1); }}
          className={`rounded-lg px-3 py-1 text-sm ${
            selectedChapter === null
              ? "bg-blue-600 text-white"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
        >
          {t("allChapters")}
        </button>
        {chapters.map((ch) => (
          <button
            key={ch.chapterNumber}
            onClick={() => { setSelectedChapter(ch.chapterNumber); setPage(1); }}
            className={`rounded-lg px-3 py-1 text-sm ${
              selectedChapter === ch.chapterNumber
                ? "bg-blue-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
          >
            {ch.chapterTitle[uiLang] || ch.chapterTitle.en || ch.chapterTitle.ja}
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder={t("searchGrammar")}
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        className="mb-4 w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-sm text-gray-100 placeholder-gray-500"
      />

      {/* Items list */}
      {loading ? (
        <p className="text-gray-400">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-gray-400">{t("noGrammarItems")}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-gray-700 bg-gray-800 p-3 cursor-pointer hover:border-gray-500"
              onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-100">
                    {item.term[uiLang] || item.term.en || item.term.ja}
                  </p>
                  <p className="text-xs text-gray-400">
                    Ch.{item.chapterNumber} — {item.subchapterTitle[uiLang] || item.subchapterTitle.en || item.subchapterTitle.ja}
                  </p>
                </div>
                {item.tags && item.tags.length > 0 && (
                  <div className="flex gap-1">
                    {item.tags.map((tag) => (
                      <span key={tag} className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {expandedId === item.id && (
                <div className="mt-3 border-t border-gray-700 pt-3">
                  {/* Description */}
                  {item.description && Object.entries(item.description).map(([lang, text]) => (
                    <p key={lang} className="text-sm text-gray-300 mb-1">
                      <span className="text-xs text-gray-500">[{lang}] </span>{text}
                    </p>
                  ))}

                  {/* Words */}
                  {item.words && item.words.length > 0 && (
                    <p className="text-sm text-gray-300">{t("grammarTerms")}: {item.words.join(", ")}</p>
                  )}

                  {/* Examples */}
                  {item.examples && item.examples.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="text-xs font-medium text-gray-400">{t("examples")}</p>
                      {item.examples.map((ex, i) => (
                        <div key={i} className="rounded bg-gray-700/50 px-3 py-2">
                          <p className="text-sm text-gray-100">{ex.sentence}</p>
                          {ex.transliteration && (
                            <p className="text-xs text-gray-400">{ex.transliteration}</p>
                          )}
                          <p className="text-xs text-gray-400">{displayTranslation(ex.translation)}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Edit / Delete buttons */}
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditingItem(item); }}
                      className="rounded bg-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-500"
                    >
                      {t("editGrammar")}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeletingId(item.id); }}
                      className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-300 hover:bg-red-800/50"
                    >
                      {t("deleteGrammar")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-4">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-lg px-3 py-1 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50"
          >
            {t("previous")}
          </button>
          <span className="text-sm text-gray-400">
            {t("page")} {page} {t("of")} {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg px-3 py-1 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50"
          >
            {t("next")}
          </button>
        </div>
      )}

      {/* Edit modal */}
      {editingItem && (
        <GrammarFormModal
          language={language}
          editItem={editingItem}
          onSave={() => { setEditingItem(null); fetchItems(); }}
          onClose={() => setEditingItem(null)}
        />
      )}

      {/* Delete confirmation dialog */}
      {deletingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setDeletingId(null)}>
          <div className="rounded-xl bg-gray-800 p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <p className="mb-4 text-sm text-gray-200">{t("deleteGrammarConfirm")}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeletingId(null)}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
              >
                {t("cancel")}
              </button>
              <button
                onClick={() => handleDelete(deletingId)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-500"
              >
                {t("deleteGrammar")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
