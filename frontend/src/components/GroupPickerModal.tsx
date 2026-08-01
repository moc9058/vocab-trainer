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
import { categoryGroups, type WordGroup, type GrammarGroup, type GroupCategory } from "../types";
import GroupNormalizePanel from "./GroupNormalizePanel";

type AnyGroup = WordGroup | GrammarGroup;

interface Props {
  kind: "word" | "grammar";
  language: string;
  itemIds: string[];
  onClose: () => void;
  /** Receives the FULL group list (both categories) so parents can keep their cache in sync. */
  onDone: (updatedGroups: AnyGroup[]) => void;
  /** Which meta-group bucket this modal lists and creates into. Default "A". */
  category?: GroupCategory;
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

export default function GroupPickerModal({
  kind,
  language,
  itemIds,
  onClose,
  onDone,
  category = "A",
}: Props) {
  const { t } = useI18n();
  // `groups` holds EVERY group for the language (both categories); only `visibleGroups`
  // is rendered. The full list is needed for the reorder invariant below.
  const [groups, setGroups] = useState<AnyGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmedDelete, setConfirmedDelete] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  // Every mutating handler here used to be try…finally with no catch — a failed
  // request surfaced as nothing but a stopped spinner (unhandled rejection).
  const [actionError, setActionError] = useState<string | null>(null);
  // Set while a normalize is being written: it re-files every word of the language,
  // so the modal must not be dismissable mid-flight.
  const [normalizeBusy, setNormalizeBusy] = useState(false);
  const newInputRef = useRef<HTMLInputElement>(null);

  const isManageMode = itemIds.length === 0;
  const canReorder = kind === "word" && isManageMode;
  // The drag order IS the category-A priority, so the rank badges and the normalize
  // action only make sense for word groups in category A. Group B keeps plain
  // reordering (cosmetic there) and grammar has no `order` at all.
  const isWordGroupAManage = kind === "word" && isManageMode && category === "A";
  const visibleGroups = categoryGroups(groups, category);
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
    setActionError(null);
    try {
      const updated = (await api.modify(language, group.id, itemIds, "add")) as AnyGroup;
      // Adding to a category-A WORD group MOVES the item there — the server strips it
      // from every other A group — so patching just this one locally would leave the
      // source group's member count stale. Re-read, falling back to the patch if that
      // read fails (the add itself already succeeded).
      const next = await api
        .list(language)
        .then((gs) => gs as AnyGroup[])
        .catch(() => groups.map((g) => (g.id === group.id ? updated : g)));
      setGroups(next);
      onDone(next);
      onClose();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setActionError(null);
    try {
      const created = (await api.create(language, name, category)) as AnyGroup;
      // Reflect the created group locally BEFORE the member-add: if that add
      // fails, the retry must go down the plain add-to-group path — pressing
      // Create again with the group absent from local state minted a second
      // group with the same name. (The id check covers the idempotent
      // category-B create, which may return a group already in the list.)
      const withCreated = groups.some((g) => g.id === created.id)
        ? groups
        : [...groups, created];
      setGroups(withCreated);
      onDone(withCreated);
      setNewName("");
      if (itemIds.length > 0) {
        const finalGroup = (await api.modify(language, created.id, itemIds, "add")) as AnyGroup;
        const next = withCreated.map((g) => (g.id === finalGroup.id ? finalGroup : g));
        setGroups(next);
        onDone(next);
        onClose();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(groupId: string) {
    const name = editName.trim();
    if (!name) return;
    setBusy(groupId);
    setActionError(null);
    try {
      const updated = (await api.rename(language, groupId, name)) as AnyGroup;
      const next = groups.map((g) => (g.id === groupId ? updated : g));
      setGroups(next);
      onDone(next);
      setEditingId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
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
    setActionError(null);
    try {
      await api.remove(language, groupId);
      const next = groups.filter((g) => g.id !== groupId);
      setGroups(next);
      setConfirmedDelete(null);
      onDone(next);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
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

    const oldIndex = visibleGroups.findIndex((group) => group.id === active.id);
    const newIndex = visibleGroups.findIndex((group) => group.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const previous = groups;
    const reordered = arrayMove(visibleGroups, oldIndex, newIndex);
    // The server requires `groupIds` to list EVERY group of the language exactly once, so
    // append the hidden category's IDs (in their current relative order) after the visible ones.
    const hidden = groups.filter((group) => !visibleGroups.some((v) => v.id === group.id));
    const next = [...reordered, ...hidden];
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
      onClick={() => { if (!normalizeBusy) onClose(); }}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-100">
            {isManageMode ? t("manageGroups") : t("addToGroup")}
            {category === "B" && <span className="ml-2 text-xs text-amber-300">Group B</span>}
          </h2>
          {!isManageMode && (
            <span className="text-xs text-gray-400">
              {itemIds.length} {itemNoun}{itemIds.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {isWordGroupAManage && !loading && visibleGroups.length > 0 && (
          <p className="mb-2 text-xs text-gray-500">{t("groupPriorityHint")}</p>
        )}

        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={visibleGroups.map((group) => group.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className={`mb-4 max-h-56 space-y-1 overflow-y-auto ${reordering ? "opacity-70" : ""}`}>
                {visibleGroups.length === 0 && (
                  <li className="text-sm text-gray-500 px-1">No groups yet.</li>
                )}
                {visibleGroups.map((group, index) => {
                  const ids = memberIds(group);
                  const containedCount = itemIds.filter((id) => ids.includes(id)).length;
                  const allSelectedContained = itemIds.length > 0 && containedCount === itemIds.length;
                  const membershipText =
                    itemIds.length === 1
                      ? "Already in group"
                      : `${containedCount}/${itemIds.length} selected already in group`;

                  return (
                    <SortableGroupRow
                      key={group.id}
                      id={group.id}
                      enabled={canReorder && !reordering && !normalizeBusy}
                    >
                  {isWordGroupAManage && (
                    <span className="w-4 shrink-0 text-right text-xs tabular-nums text-gray-500">
                      {index + 1}
                    </span>
                  )}
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
                          {/* Priority #1 is also where every "add a word" flow files by
                              default (types.ts:defaultWordGroup). Saying so here is the
                              only place that relationship is visible. */}
                          {isWordGroupAManage && index === 0 && (
                            <span className="ml-2 rounded-full border border-indigo-700/50 bg-indigo-950/40 px-1.5 py-0.5 text-[11px] text-indigo-300">
                              {t("defaultAddTarget")}
                            </span>
                          )}
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

        {actionError && <p className="mb-2 text-xs text-red-400">{actionError}</p>}

        {isWordGroupAManage && !loading && visibleGroups.length > 0 && (
          <GroupNormalizePanel
            language={language}
            aGroups={visibleGroups as WordGroup[]}
            busy={reordering}
            onBusyChange={setNormalizeBusy}
            onError={setActionError}
            onApplied={(saved) => {
              setGroups(saved);
              onDone(saved);
            }}
          />
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
            disabled={normalizeBusy}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
