import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import {
  getGrammarItems,
  deleteGrammarItem,
  getGrammarGroups,
  modifyGrammarGroupMembers,
} from "../api/grammar";
import type { Grammar, GrammarGroup } from "../types";
import GrammarFormModal from "./GrammarFormModal";
import GroupPickerModal from "./GroupPickerModal";
import RubyText from "./RubyText";
import type { smartAddWord } from "../api/vocab";
import type { useGrammarQueue } from "../hooks/useGrammarQueue";

type SmartAddPayload = Parameters<typeof smartAddWord>[1];
type GrammarEnqueue = ReturnType<typeof useGrammarQueue>["enqueue"];
type GrammarEnqueueUpdate = ReturnType<typeof useGrammarQueue>["enqueueUpdate"];

interface Props {
  language: string;
  onBack: () => void;
  /** Passed straight through to the embedded GrammarFormModal so chip-clicks
   *  in the grammar editor enqueue into the shared word-add queue and surface
   *  in the global Dashboard "Generating:" pill. */
  onQueue?: (term: string, language: string, payload: SmartAddPayload) => void;
  /** When provided, grammar create-mode submits enqueue into the shared grammar
   *  queue instead of awaiting directly, keeping the modal open for rapid adds. */
  onGrammarQueue?: GrammarEnqueue;
  /** When provided, grammar edit-mode submits enqueue instead of awaiting. */
  onGrammarUpdateQueue?: GrammarEnqueueUpdate;
  pendingTerms?: Set<string>;
  refreshSignal?: number;
}

export default function GrammarList({ language, onBack, onQueue, onGrammarQueue, onGrammarUpdateQueue, pendingTerms, refreshSignal }: Props) {
  const { t } = useI18n();
  const { displayGrammarDefEntries } = useSettings();
  const [items, setItems] = useState<Grammar[]>([]);
  const [groups, setGroups] = useState<GrammarGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingItem, setEditingItem] = useState<Grammar | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [groupPickerIds, setGroupPickerIds] = useState<string[] | null>(null);

  useEffect(() => {
    getGrammarGroups(language)
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [language]);

  const fetchItems = useCallback(() => {
    setLoading(true);
    getGrammarItems(
      language,
      {
        groupId: selectedGroupId || undefined,
        search: search || undefined,
      },
      page,
      20
    )
      .then((result) => {
        setItems(result.items);
        setTotalPages(result.totalPages);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [language, selectedGroupId, search, page, refreshSignal]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  async function handleDelete(grammarId: string) {
    try {
      await deleteGrammarItem(language, grammarId);
      setDeletingId(null);
      fetchItems();
    } catch {
      // keep dialog open on error
    }
  }

  async function handleRemoveFromGroup(grammarId: string) {
    if (!selectedGroupId) return;
    const updated = await modifyGrammarGroupMembers(language, selectedGroupId, [grammarId], "remove");
    setGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
    fetchItems();
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-100">{t("grammarBrowse")}</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("addGrammar")}
          </button>
          <button
            onClick={onBack}
            className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("back")}
          </button>
        </div>
      </div>

      {/* Group filter + Manage Groups */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={selectedGroupId}
          onChange={(e) => { setSelectedGroupId(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
        >
          <option value="">{t("grammarGroups")}: All</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.grammarIds.length})
            </option>
          ))}
        </select>
        <button
          onClick={() => setGroupPickerIds([])}
          className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
        >
          {t("manageGroups")}
        </button>
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
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-100 truncate">
                    {item.statement}
                  </p>
                  {(item.level || (item.descriptions?.[0]?.partOfSpeech)) && (
                    <p className="text-xs text-gray-400">
                      {item.descriptions?.[0]?.partOfSpeech ?? ""}
                      {item.descriptions?.[0]?.partOfSpeech && item.level ? " · " : ""}
                      {item.level ?? ""}
                    </p>
                  )}
                </div>
                {item.tags && item.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
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
                  {/* Descriptions */}
                  {item.descriptions?.map((d, di) => {
                    const entries = displayGrammarDefEntries(d.text || {});
                    return (
                      <div key={di} className="mb-2">
                        {d.partOfSpeech && (
                          <span className="mr-2 rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300">
                            {d.partOfSpeech}
                          </span>
                        )}
                        {d.pinyins && d.pinyins.length > 0 && (
                          <span className="mr-2 text-xs text-gray-400">{d.pinyins.join(", ")}</span>
                        )}
                        <div className="ml-1 mt-1 space-y-0.5">
                          {entries.length > 0
                            ? entries.map(([lang, text]) => (
                                <p key={lang} className="text-sm text-gray-300">
                                  <span className="text-xs text-gray-500">[{lang}] </span>
                                  {text}
                                </p>
                              ))
                            : Object.entries(d.text || {}).map(([lang, text]) => (
                                <p key={lang} className="text-sm text-gray-300">
                                  <span className="text-xs text-gray-500">[{lang}] </span>
                                  {text}
                                </p>
                              ))}
                        </div>
                      </div>
                    );
                  })}

                  {/* Related words */}
                  {item.words && item.words.length > 0 && (
                    <p className="mt-2 text-sm text-gray-300">
                      {t("grammarTerms")}: {item.words.join(", ")}
                    </p>
                  )}

                  {/* Examples */}
                  {item.examples && item.examples.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="text-xs font-medium text-gray-400">{t("examples")}</p>
                      {item.examples.map((ex, i) => (
                        <div key={i} className="rounded bg-gray-700/50 px-3 py-2">
                          <p className="text-sm text-gray-100">
                            <RubyText text={ex.sentence} segments={ex.segments} />
                          </p>
                          {ex.transliteration && (
                            <p className="text-xs text-gray-400">{ex.transliteration}</p>
                          )}
                          <p className="text-xs text-gray-400">{ex.translation}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditingItem(item); }}
                      className="rounded bg-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-500"
                    >
                      {t("editGrammar")}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setGroupPickerIds([item.id]); }}
                      className="rounded bg-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-500"
                    >
                      {t("addToGroup")}
                    </button>
                    {selectedGroupId && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleRemoveFromGroup(item.id); }}
                        className="rounded bg-amber-900/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-800/50"
                      >
                        Remove from group
                      </button>
                    )}
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

      {/* Add modal */}
      {showAddModal && (
        <GrammarFormModal
          language={language}
          onSave={() => { setShowAddModal(false); fetchItems(); }}
          onClose={() => setShowAddModal(false)}
          onQueue={onQueue}
          onGrammarQueue={onGrammarQueue}
          pendingTerms={pendingTerms}
          refreshSignal={refreshSignal}
        />
      )}

      {/* Edit modal */}
      {editingItem && (
        <GrammarFormModal
          language={language}
          editItem={editingItem}
          onSave={() => { setEditingItem(null); fetchItems(); }}
          onClose={() => setEditingItem(null)}
          onQueue={onQueue}
          onGrammarUpdateQueue={onGrammarUpdateQueue}
          pendingTerms={pendingTerms}
          refreshSignal={refreshSignal}
        />
      )}

      {/* Group picker modal */}
      {groupPickerIds && (
        <GroupPickerModal
          kind="grammar"
          language={language}
          itemIds={groupPickerIds}
          onClose={() => setGroupPickerIds(null)}
          onDone={(updated) => {
            setGroups(updated as GrammarGroup[]);
            setGroupPickerIds(null);
            fetchItems();
          }}
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
