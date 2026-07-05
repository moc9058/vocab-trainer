import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import {
  getGrammarItems,
  deleteGrammarItem,
  getGrammarGroups,
  modifyGrammarGroupMembers,
} from "../api/grammar";
import { LEVEL_OPTIONS } from "../constants/levels";
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
  succeededTerms?: Set<string>;
  refreshSignal?: number;
}

interface ItemProps {
  item: Grammar;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddToGroup: () => void;
  onRemoveFromGroup: (() => void) | null;
  selected: boolean;
  onToggleSelect: () => void;
  displayGrammarDefEntries: (record: Record<string, string>) => [string, string][];
}

function GrammarDetail({ item, onEdit, onDelete, onAddToGroup, onRemoveFromGroup, displayGrammarDefEntries }: ItemProps) {
  const { t } = useI18n();
  return (
    <div className="mt-3 border-t border-gray-700 pt-3">
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

      {item.words && item.words.length > 0 && (
        <p className="mt-2 text-sm text-gray-300">
          {t("grammarTerms")}: {item.words.join(", ")}
        </p>
      )}

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

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="rounded bg-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-500"
        >
          {t("editGrammar")}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onAddToGroup(); }}
          className="rounded bg-gray-600 px-2 py-1 text-xs text-gray-200 hover:bg-gray-500"
        >
          {t("addToGroup")}
        </button>
        {onRemoveFromGroup && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemoveFromGroup(); }}
            className="rounded bg-amber-900/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-800/50"
          >
            Remove from group
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-300 hover:bg-red-800/50"
        >
          {t("deleteGrammar")}
        </button>
      </div>
    </div>
  );
}

function GrammarCard(props: ItemProps) {
  const { item, expanded, onToggle, selected, onToggleSelect } = props;
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-3 hover:border-gray-500">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => { e.stopPropagation(); onToggleSelect(); }}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 accent-red-500"
        />
        <div className="flex-1 cursor-pointer" onClick={onToggle}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-100 truncate">{item.statement}</p>
              {(item.level || item.descriptions?.[0]?.partOfSpeech) && (
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
          {expanded && <GrammarDetail {...props} />}
        </div>
      </div>
    </div>
  );
}

function GrammarRow(props: ItemProps) {
  const { item, expanded, onToggle, selected, onToggleSelect } = props;
  return (
    <>
      <tr className="cursor-pointer border-b border-gray-700 hover:bg-gray-700/40" onClick={onToggle}>
        <td className="py-2 pr-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => { e.stopPropagation(); onToggleSelect(); }}
            onClick={(e) => e.stopPropagation()}
            className="accent-red-500"
          />
        </td>
        <td className="py-2 pr-4 text-sm text-gray-100">{item.statement}</td>
        <td className="py-2 pr-4 text-sm text-gray-300">{item.descriptions?.[0]?.partOfSpeech ?? ""}</td>
        <td className="py-2 pr-4 text-sm text-gray-300">{item.level ?? ""}</td>
        <td className="py-2 text-sm text-gray-400">{item.tags?.join(", ") ?? ""}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-700 bg-gray-800/60">
          <td colSpan={5} className="px-3 pb-3">
            <GrammarDetail {...props} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function GrammarList({ language, onBack, onQueue, onGrammarQueue, onGrammarUpdateQueue, pendingTerms, succeededTerms, refreshSignal }: Props) {
  const { t } = useI18n();
  const { displayGrammarDefEntries } = useSettings();
  const [items, setItems] = useState<Grammar[]>([]);
  const [groups, setGroups] = useState<GrammarGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [level, setLevel] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingItem, setEditingItem] = useState<Grammar | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [groupPickerIds, setGroupPickerIds] = useState<string[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const levelOptions = LEVEL_OPTIONS[language];

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
        level: level || undefined,
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
  }, [language, selectedGroupId, search, level, page, refreshSignal]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  async function handleDelete(grammarId: string) {
    try {
      await deleteGrammarItem(language, grammarId);
      setDeletingId(null);
      setSelectedIds((prev) => {
        if (!prev.has(grammarId)) return prev;
        const next = new Set(prev);
        next.delete(grammarId);
        return next;
      });
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

  function toggleSelected(itemId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function toggleSelectAllOnPage() {
    const pageIds = items.map((i) => i.id);
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
        await deleteGrammarItem(language, id);
      }
      setSelectedIds(new Set());
      setExpandedId(null);
      setShowBulkDeleteConfirm(false);
      await fetchItems();
    } finally {
      setBulkDeleting(false);
    }
  }

  const pageIds = items.map((i) => i.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));

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

      {/* Group + level filters */}
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
        {levelOptions && (
          <select
            value={level}
            onChange={(e) => { setLevel(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
          >
            <option value="">{t("level")}</option>
            {levelOptions.map((lv) => (
              <option key={lv} value={lv}>{lv}</option>
            ))}
          </select>
        )}
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

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-gray-700 bg-gray-800/80 px-3 py-2">
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
              onClick={() => setGroupPickerIds([...selectedIds])}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
            >
              {t("addToGroup")}
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

      {/* Items list */}
      {loading ? (
        <p className="text-gray-400">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-gray-400">{t("noGrammarItems")}</p>
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="space-y-2 md:hidden">
            {items.map((item) => (
              <GrammarCard
                key={item.id}
                item={item}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                onEdit={() => setEditingItem(item)}
                onDelete={() => setDeletingId(item.id)}
                onAddToGroup={() => setGroupPickerIds([item.id])}
                onRemoveFromGroup={selectedGroupId ? () => handleRemoveFromGroup(item.id) : null}
                selected={selectedIds.has(item.id)}
                onToggleSelect={() => toggleSelected(item.id)}
                displayGrammarDefEntries={displayGrammarDefEntries}
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
                <th className="pb-2 pr-4 font-medium">{t("grammarStatement")}</th>
                <th className="pb-2 pr-4 font-medium">{t("grammarDescriptions")}</th>
                <th className="pb-2 pr-4 font-medium">{t("level")}</th>
                <th className="pb-2 font-medium">Tags</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <GrammarRow
                  key={item.id}
                  item={item}
                  expanded={expandedId === item.id}
                  onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                  onEdit={() => setEditingItem(item)}
                  onDelete={() => setDeletingId(item.id)}
                  onAddToGroup={() => setGroupPickerIds([item.id])}
                  onRemoveFromGroup={selectedGroupId ? () => handleRemoveFromGroup(item.id) : null}
                  selected={selectedIds.has(item.id)}
                  onToggleSelect={() => toggleSelected(item.id)}
                  displayGrammarDefEntries={displayGrammarDefEntries}
                />
              ))}
            </tbody>
          </table>
        </>
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
          succeededTerms={succeededTerms}
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
          succeededTerms={succeededTerms}
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

      {/* Bulk delete confirmation dialog */}
      {showBulkDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !bulkDeleting && setShowBulkDeleteConfirm(false)}>
          <div className="rounded-xl bg-gray-800 p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <p className="mb-4 text-sm text-gray-200">
              {selectedIds.size} {t("selectedCount")} — {t("deleteGrammarConfirm")}
            </p>
            <div className="flex justify-end gap-3">
              <button
                disabled={bulkDeleting}
                onClick={() => setShowBulkDeleteConfirm(false)}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50"
              >
                {t("cancel")}
              </button>
              <button
                disabled={bulkDeleting}
                onClick={handleBulkDelete}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-500 disabled:opacity-50"
              >
                {t("deleteSelected")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
