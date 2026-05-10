import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import { getGroups, createGroup, modifyGroupMembers, renameGroup, deleteGroup } from "../api/vocab";
import type { WordGroup } from "../types";

interface Props {
  language: string;
  wordIds: string[];
  onClose: () => void;
  onDone: (updatedGroups: WordGroup[]) => void;
}

export default function GroupPickerModal({ language, wordIds, onClose, onDone }: Props) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<WordGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmedDelete, setConfirmedDelete] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  const isManageMode = wordIds.length === 0;

  useEffect(() => {
    getGroups(language)
      .then(setGroups)
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [language]);

  async function handleAddToGroup(group: WordGroup) {
    setBusy(group.id);
    try {
      const updated = await modifyGroupMembers(language, group.id, wordIds, "add");
      const next = groups.map((g) => (g.id === group.id ? updated : g));
      setGroups(next);
      onDone(next);
      onClose();
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const group = await createGroup(language, name);
      let finalGroup = group;
      if (wordIds.length > 0) {
        finalGroup = await modifyGroupMembers(language, group.id, wordIds, "add");
      }
      const next = [...groups, finalGroup];
      setGroups(next);
      setNewName("");
      if (wordIds.length > 0) {
        onDone(next);
        onClose();
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(groupId: string) {
    const name = editName.trim();
    if (!name) return;
    setBusy(groupId);
    try {
      const updated = await renameGroup(language, groupId, name);
      setGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
      setEditingId(null);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(groupId: string) {
    if (confirmedDelete !== groupId) {
      setConfirmedDelete(groupId);
      return;
    }
    setBusy(groupId);
    try {
      await deleteGroup(language, groupId);
      const next = groups.filter((g) => g.id !== groupId);
      setGroups(next);
      setConfirmedDelete(null);
      onDone(next);
    } finally {
      setBusy(null);
    }
  }

  function startEdit(group: WordGroup) {
    setEditingId(group.id);
    setEditName(group.name);
    setConfirmedDelete(null);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-100">
            {isManageMode ? t("manageGroups") : t("addToGroup")}
          </h2>
          {!isManageMode && (
            <span className="text-xs text-gray-400">
              {wordIds.length} word{wordIds.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <ul className="mb-4 max-h-56 space-y-1 overflow-y-auto">
            {groups.length === 0 && (
              <li className="text-sm text-gray-500 px-1">No groups yet.</li>
            )}
            {groups.map((group) => {
              const containedCount = wordIds.filter((wordId) => group.wordIds.includes(wordId)).length;
              const allSelectedContained = wordIds.length > 0 && containedCount === wordIds.length;
              const membershipText =
                wordIds.length === 1
                  ? "Already in group"
                  : `${containedCount}/${wordIds.length} selected already in group`;

              return (
                <li key={group.id} className="flex items-center gap-2">
                      {editingId === group.id ? (
                        <>
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRename(group.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            className="flex-1 min-w-0 rounded border border-gray-500 bg-gray-700 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                          />
                          <button
                            onClick={() => handleRename(group.id)}
                            disabled={busy === group.id}
                            className="rounded px-2 py-1 text-xs bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-700"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <>
                          {!isManageMode ? (
                            <button
                              onClick={() => handleAddToGroup(group)}
                              disabled={busy === group.id || allSelectedContained}
                              className={`flex-1 min-w-0 rounded-lg px-3 py-1.5 text-left text-sm disabled:opacity-70 ${
                                allSelectedContained
                                  ? "cursor-default border border-green-700/40 bg-green-950/20 text-gray-300"
                                  : "text-gray-200 hover:bg-gray-700"
                              }`}
                            >
                              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="min-w-0 truncate">{busy === group.id ? "Adding…" : group.name}</span>
                                <span className="text-xs text-gray-500">{group.wordIds.length} words</span>
                                {containedCount > 0 && (
                                  <span className="rounded-full border border-green-700/50 bg-green-950/40 px-1.5 py-0.5 text-[11px] text-green-300">
                                    ✓ {membershipText}
                                  </span>
                                )}
                              </span>
                            </button>
                          ) : (
                            <span className="flex-1 min-w-0 truncate text-sm text-gray-200 px-1">
                              {group.name}
                              <span className="ml-2 text-xs text-gray-500">{group.wordIds.length} words</span>
                            </span>
                          )}
                          {isManageMode && (
                            <button
                              onClick={() => startEdit(group)}
                              className="rounded px-1.5 py-1 text-xs text-gray-400 hover:bg-gray-700"
                              title={t("renameGroup")}
                            >
                              ✏
                            </button>
                          )}
                          {isManageMode && (
                            <button
                              onClick={() => handleDelete(group.id)}
                              disabled={busy === group.id}
                              className={`rounded px-1.5 py-1 text-xs disabled:opacity-50 ${
                                confirmedDelete === group.id
                                  ? "bg-red-600 text-white hover:bg-red-500"
                                  : "text-gray-400 hover:bg-gray-700"
                              }`}
                              title={confirmedDelete === group.id ? "Click again to confirm" : t("deleteGroup")}
                            >
                              {confirmedDelete === group.id ? "Confirm?" : "✕"}
                            </button>
                          )}
                        </>
                      )}
                </li>
              );
            })}
          </ul>
        )}

        {/* New group input */}
        <div className="flex gap-2">
          <input
            ref={newInputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
            placeholder={t("createGroup")}
            className="flex-1 min-w-0 rounded-lg border border-gray-600 bg-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-400 focus:border-blue-400 focus:outline-none"
          />
          <button
            onClick={handleCreate}
            disabled={!newName.trim() || creating}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {creating ? "…" : isManageMode ? "Create" : "+ Create & Add"}
          </button>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
