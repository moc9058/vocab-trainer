import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useI18n } from "../i18n/context";
import {
  getGroups,
  createGroup,
  modifyGroupMembers,
  renameGroup,
  reorderGroups,
  deleteGroup,
} from "../api/vocab";
import {
  getGrammarGroups,
  createGrammarGroup,
  renameGrammarGroup,
  deleteGrammarGroup,
  modifyGrammarGroupMembers,
} from "../api/grammar";
import type { WordGroup, GrammarGroup } from "../types";

type AnyGroup = WordGroup | GrammarGroup;

interface Props {
  kind: "word" | "grammar";
  language: string;
  itemIds: string[];
  onClose: () => void;
  onDone: (updatedGroups: AnyGroup[]) => void;
}

function memberIds(g: AnyGroup): string[] {
  return (g as WordGroup).wordIds ?? (g as GrammarGroup).grammarIds ?? [];
}

function SortableGroupRow({
  id,
  enabled,
  children,
}: {
  id: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !enabled,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded ${isDragging ? "z-10 bg-gray-700 shadow-lg" : ""}`}
    >
      {enabled && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none rounded px-1 py-1 text-gray-500 hover:bg-gray-700 hover:text-gray-300 active:cursor-grabbing"
          aria-label="Drag to reorder group"
          title="Drag to reorder"
        >
          ⠿
        </button>
      )}
      {children}
    </li>
  );
}

export default function GroupPickerModal({ kind, language, itemIds, onClose, onDone }: Props) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<AnyGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmedDelete, setConfirmedDelete] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const newInputRef = useRef<HTMLInputElement>(null);

  const isManageMode = itemIds.length === 0;
  const canReorder = kind === "word" && isManageMode;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const api = {
    list: kind === "word" ? getGroups : getGrammarGroups,
    create: kind === "word" ? createGroup : createGrammarGroup,
    rename: kind === "word" ? renameGroup : renameGrammarGroup,
    remove: kind === "word" ? deleteGroup : deleteGrammarGroup,
    modify:
      kind === "word"
        ? modifyGroupMembers
        : (lang: string, groupId: string, ids: string[], action: "add" | "remove") =>
            modifyGrammarGroupMembers(lang, groupId, ids, action),
  } as const;

  useEffect(() => {
    api
      .list(language)
      .then((gs) => setGroups(gs as AnyGroup[]))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, kind]);

  async function handleAddToGroup(group: AnyGroup) {
    setBusy(group.id);
    try {
      const updated = (await api.modify(language, group.id, itemIds, "add")) as AnyGroup;
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
      const group = (await api.create(language, name)) as AnyGroup;
      let finalGroup = group;
      if (itemIds.length > 0) {
        finalGroup = (await api.modify(language, group.id, itemIds, "add")) as AnyGroup;
      }
      const next = [...groups, finalGroup];
      setGroups(next);
      onDone(next);
      setNewName("");
      if (itemIds.length > 0) {
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
      const updated = (await api.rename(language, groupId, name)) as AnyGroup;
      const next = groups.map((g) => (g.id === groupId ? updated : g));
      setGroups(next);
      onDone(next);
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
      await api.remove(language, groupId);
      const next = groups.filter((g) => g.id !== groupId);
      setGroups(next);
      setConfirmedDelete(null);
      onDone(next);
    } finally {
      setBusy(null);
    }
  }

  function startEdit(group: AnyGroup) {
    setEditingId(group.id);
    setEditName(group.name);
    setConfirmedDelete(null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!canReorder || !over || active.id === over.id || reordering) return;

    const oldIndex = groups.findIndex((group) => group.id === active.id);
    const newIndex = groups.findIndex((group) => group.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const previous = groups;
    const next = arrayMove(groups, oldIndex, newIndex);
    setGroups(next);
    setReordering(true);
    try {
      const saved = await reorderGroups(language, next.map((group) => group.id));
      setGroups(saved);
      onDone(saved);
    } catch {
      setGroups(previous);
    } finally {
      setReordering(false);
    }
  }

  const itemNoun = kind === "word" ? "word" : "grammar";

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
              {itemIds.length} {itemNoun}{itemIds.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={groups.map((group) => group.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className={`mb-4 max-h-56 space-y-1 overflow-y-auto ${reordering ? "opacity-70" : ""}`}>
                {groups.length === 0 && (
                  <li className="text-sm text-gray-500 px-1">No groups yet.</li>
                )}
                {groups.map((group) => {
                  const ids = memberIds(group);
                  const containedCount = itemIds.filter((id) => ids.includes(id)).length;
                  const allSelectedContained = itemIds.length > 0 && containedCount === itemIds.length;
                  const membershipText =
                    itemIds.length === 1
                      ? "Already in group"
                      : `${containedCount}/${itemIds.length} selected already in group`;

                  return (
                    <SortableGroupRow key={group.id} id={group.id} enabled={canReorder && !reordering}>
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
                            <span className="text-xs text-gray-500">{ids.length} {itemNoun}s</span>
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
                          <span className="ml-2 text-xs text-gray-500">{ids.length} {itemNoun}s</span>
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
                    </SortableGroupRow>
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
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
