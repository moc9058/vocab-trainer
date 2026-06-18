import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../i18n/context";
import {
  getExpressions,
  deleteExpression,
  getExpressionGroups,
  createExpressionGroup,
  renameExpressionGroup,
  deleteExpressionGroup,
  modifyExpressionGroupMembers,
} from "../api/expressions";
import type { Expression, ExpressionGroup } from "../types";
import ExpressionFormModal from "./ExpressionFormModal";

interface Props {
  language: string;
  onBack: () => void;
}

export default function ExpressionList({ language, onBack }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<Expression[]>([]);
  const [groups, setGroups] = useState<ExpressionGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<Expression | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Group management
  const [newGroupName, setNewGroupName] = useState("");
  const [renamingGroup, setRenamingGroup] = useState<{ id: string; name: string } | null>(null);
  const [showGroupManager, setShowGroupManager] = useState(false);

  useEffect(() => {
    getExpressionGroups(language)
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [language]);

  const fetchItems = useCallback(() => {
    setLoading(true);
    getExpressions(language, { groupId: selectedGroupId || undefined, search: search || undefined }, page, 20)
      .then((result) => {
        setItems(result.items);
        setTotalPages(result.totalPages);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [language, selectedGroupId, search, page]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  async function handleDelete(id: string) {
    try {
      await deleteExpression(language, id);
      setDeletingId(null);
      fetchItems();
    } catch {
      // keep dialog open
    }
  }

  async function handleRemoveFromGroup(id: string) {
    if (!selectedGroupId) return;
    await modifyExpressionGroupMembers(language, selectedGroupId, [id], "remove");
    fetchItems();
  }

  async function handleCreateGroup() {
    if (!newGroupName.trim()) return;
    const g = await createExpressionGroup(language, newGroupName.trim());
    setGroups((prev) => [...prev, g]);
    setNewGroupName("");
  }

  async function handleRenameGroup() {
    if (!renamingGroup || !renamingGroup.name.trim()) return;
    const updated = await renameExpressionGroup(language, renamingGroup.id, renamingGroup.name.trim());
    setGroups((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
    setRenamingGroup(null);
  }

  async function handleDeleteGroup(groupId: string) {
    await deleteExpressionGroup(language, groupId);
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
    if (selectedGroupId === groupId) setSelectedGroupId("");
  }

  const purposeLabel = (purpose?: ("speaking" | "writing")[]) => {
    if (!purpose || purpose.length === 0) return null;
    return purpose.map((p) => (p === "speaking" ? t("purposeSpeaking") : t("purposeWriting"))).join(", ");
  };

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-100">{t("browseExpressions")}</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="rounded-lg bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-500 transition-colors"
          >
            + {t("addExpression")}
          </button>
          <button
            onClick={onBack}
            className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("back")}
          </button>
        </div>
      </div>

      {/* Search + group filter */}
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder={t("searchPlaceholder")}
          className="flex-1 min-w-40 rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:border-orange-400 focus:outline-none"
        />
        <select
          value={selectedGroupId}
          onChange={(e) => { setSelectedGroupId(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm text-gray-300 focus:border-orange-400 focus:outline-none"
        >
          <option value="">{t("noGroupFilter")}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <button
          onClick={() => setShowGroupManager(!showGroupManager)}
          className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-700 transition-colors"
        >
          {t("groups")}
        </button>
      </div>

      {/* Group manager */}
      {showGroupManager && (
        <div className="mb-4 rounded-lg border border-gray-700 bg-gray-800/60 p-4 space-y-3">
          <p className="text-sm font-medium text-gray-300">{t("groups")}</p>
          {groups.map((g) => (
            <div key={g.id} className="flex items-center gap-2">
              {renamingGroup?.id === g.id ? (
                <>
                  <input
                    type="text"
                    value={renamingGroup.name}
                    onChange={(e) => setRenamingGroup({ id: g.id, name: e.target.value })}
                    className="flex-1 rounded border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-gray-100"
                    autoFocus
                  />
                  <button onClick={handleRenameGroup} className="text-xs text-orange-400 hover:text-orange-300">{t("save")}</button>
                  <button onClick={() => setRenamingGroup(null)} className="text-xs text-gray-500 hover:text-gray-400">{t("cancel")}</button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm text-gray-300">{g.name}</span>
                  <span className="text-xs text-gray-500">{g.expressionIds.length}</span>
                  <button onClick={() => setRenamingGroup({ id: g.id, name: g.name })} className="text-xs text-gray-400 hover:text-gray-200">{t("editWord")}</button>
                  <button onClick={() => handleDeleteGroup(g.id)} className="text-xs text-red-400 hover:text-red-300">{t("deleteWord")}</button>
                </>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder={t("createGroup")}
              onKeyDown={(e) => e.key === "Enter" && handleCreateGroup()}
              className="flex-1 rounded border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-gray-100 placeholder-gray-500"
            />
            <button
              onClick={handleCreateGroup}
              disabled={!newGroupName.trim()}
              className="rounded bg-orange-600 px-3 py-1 text-xs text-white hover:bg-orange-500 disabled:opacity-50"
            >
              {t("createGroup")}
            </button>
          </div>
        </div>
      )}

      {/* Items list */}
      {loading ? (
        <div className="flex justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-orange-400 border-t-transparent" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-center text-gray-500 py-8">{t("noWordsFound")}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-gray-700 bg-gray-800/60">
              <button
                className="w-full px-4 py-3 text-left"
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-100">{item.phrase}</p>
                    <p className="text-sm text-gray-400 truncate">{item.context}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {purposeLabel(item.purpose) && (
                      <span className="rounded-full border border-orange-700 bg-orange-900/30 px-2 py-0.5 text-xs text-orange-300">
                        {purposeLabel(item.purpose)}
                      </span>
                    )}
                    <span className="text-gray-500 text-sm">{expandedId === item.id ? "▲" : "▼"}</span>
                  </div>
                </div>
              </button>

              {expandedId === item.id && (
                <div className="border-t border-gray-700 px-4 py-3 space-y-2">
                  <div>
                    <p className="text-xs text-gray-500 mb-0.5">{t("expressionContext")}</p>
                    <p className="text-sm text-gray-300">{item.context}</p>
                  </div>
                  {item.description && (
                    <div>
                      <p className="text-xs text-gray-500 mb-0.5">{t("expressionDescription")}</p>
                      <p className="text-sm text-gray-300 whitespace-pre-wrap">{item.description}</p>
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => setEditingItem(item)}
                      className="rounded bg-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-600"
                    >
                      {t("editWord")}
                    </button>
                    {selectedGroupId && (
                      <button
                        onClick={() => handleRemoveFromGroup(item.id)}
                        className="rounded bg-gray-700 px-3 py-1 text-xs text-gray-400 hover:bg-gray-600"
                      >
                        Remove from group
                      </button>
                    )}
                    <button
                      onClick={() => setDeletingId(item.id)}
                      className="rounded bg-red-900/40 px-3 py-1 text-xs text-red-400 hover:bg-red-900/60"
                    >
                      {t("deleteWord")}
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
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-400 hover:bg-gray-700 disabled:opacity-40"
          >
            {t("previous")}
          </button>
          <span className="text-sm text-gray-400">{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-400 hover:bg-gray-700 disabled:opacity-40"
          >
            {t("next")}
          </button>
        </div>
      )}

      {/* Delete confirmation */}
      {deletingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-xl bg-gray-800 p-6 shadow-lg">
            <p className="mb-4 text-gray-300">{t("deleteWordConfirm")}</p>
            <div className="flex gap-3">
              <button
                onClick={() => handleDelete(deletingId)}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-500"
              >
                {t("deleteWord")}
              </button>
              <button
                onClick={() => setDeletingId(null)}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-2 text-gray-300 hover:bg-gray-600"
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit modal */}
      {(showAddModal || editingItem) && (
        <ExpressionFormModal
          language={language}
          editItem={editingItem ?? undefined}
          onSave={() => {
            setShowAddModal(false);
            setEditingItem(null);
            fetchItems();
          }}
          onClose={() => {
            setShowAddModal(false);
            setEditingItem(null);
          }}
        />
      )}
    </div>
  );
}
