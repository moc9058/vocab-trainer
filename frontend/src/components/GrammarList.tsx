import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import {
  getGrammarItems,
  deleteGrammarItem,
  getGrammarGroups,
  modifyGrammarGroupMembers,
  getGrammarDrafts,
  updateGrammarDraft,
  deleteGrammarDraft,
  uploadGrammarDrafts,
} from "../api/grammar";
import { LEVEL_OPTIONS } from "../constants/levels";
import { latestGrammarGroup, type Grammar, type GrammarDraft, type GrammarGroup } from "../types";
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
  /** Grammar queue's pending statements — marks drafts whose registration is
   *  in flight (Review/Discard disabled until the queue retires the draft). */
  grammarPendingTerms?: Set<string>;
  /** Grammar queue's pending draft IDs — the precise in-flight marker
   *  (statement matching is the legacy fallback). */
  grammarPendingDraftIds?: Set<string>;
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
              {typeof ex.translation === "string" ? (
                <p className="text-xs text-gray-400">{ex.translation}</p>
              ) : (
                displayGrammarDefEntries(ex.translation).map(([lang, text]) => (
                  <p key={lang} className="text-xs text-gray-400">
                    <span className="mr-1.5 text-xs font-medium uppercase text-gray-500">{lang}</span>
                    {text}
                  </p>
                ))
              )}
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
              {item.transliteration && (
                <p className="text-xs text-gray-500 truncate">{item.transliteration}</p>
              )}
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
        <td className="py-2 pr-4 text-sm text-gray-100">
          {item.statement}
          {item.transliteration && <span className="ml-2 text-xs text-gray-500">{item.transliteration}</span>}
        </td>
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

export default function GrammarList({ language, onBack, onQueue, onGrammarQueue, onGrammarUpdateQueue, pendingTerms, succeededTerms, grammarPendingTerms, grammarPendingDraftIds, refreshSignal }: Props) {
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
  const [drafts, setDrafts] = useState<GrammarDraft[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [reviewingDraft, setReviewingDraft] = useState<GrammarDraft | null>(null);
  const [discardingDraftId, setDiscardingDraftId] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const jsonFileInputRef = useRef<HTMLInputElement>(null);
  // Registration target for the drafts panel's one-click "Register" button.
  // Defaults to the most recently CREATED group; a user pick sticks.
  const [draftGroupId, setDraftGroupId] = useState<string>("");
  const draftGroupTouchedRef = useRef(false);

  const levelOptions = LEVEL_OPTIONS[language];

  useEffect(() => {
    getGrammarGroups(language)
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [language]);

  useEffect(() => {
    if (draftGroupTouchedRef.current) return;
    setDraftGroupId(latestGrammarGroup(groups)?.id ?? "");
  }, [groups]);

  useEffect(() => {
    draftGroupTouchedRef.current = false;
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

  const fetchDrafts = useCallback(() => {
    getGrammarDrafts(language)
      .then(setDrafts)
      .catch(() => setDrafts([]));
  }, [language, refreshSignal]);

  useEffect(() => {
    fetchDrafts();
  }, [fetchDrafts]);

  // See docs/draft-json-format.md for the accepted file format (kind: "grammar-drafts").
  async function handleDraftsJsonFile(file: File) {
    setUploading(true);
    setUploadStatus(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error(t("draftsJsonInvalid"));
      }
      const obj = parsed as Record<string, unknown>;
      if (!obj || typeof obj !== "object" || !Array.isArray(obj.drafts) || obj.drafts.length === 0) {
        throw new Error(t("draftsJsonInvalid"));
      }
      if (obj.kind !== undefined && obj.kind !== "grammar-drafts") {
        throw new Error(t("draftsJsonInvalid"));
      }
      if (obj.language !== language) {
        throw new Error(`${t("draftsJsonLanguageMismatch")} (${String(obj.language)} ≠ ${language})`);
      }
      const payload = (obj.drafts as Record<string, unknown>[]).map((d, i) => {
        if (typeof d.statement !== "string" || !d.statement.trim() ||
            !Array.isArray(d.descriptions) || d.descriptions.length === 0) {
          throw new Error(`${t("draftsJsonInvalid")} (drafts[${i}])`);
        }
        return {
          statement: d.statement.trim(),
          descriptions: d.descriptions as GrammarDraft["descriptions"],
          ...(Array.isArray(d.examples) ? { examples: d.examples as GrammarDraft["examples"] } : {}),
          ...(typeof d.level === "string" && d.level ? { level: d.level } : {}),
          ...(Array.isArray(d.tags) ? { tags: d.tags as string[] } : {}),
          ...(typeof d.sourceImage === "string" && d.sourceImage ? { sourceImage: d.sourceImage } : {}),
        };
      });
      const result = await uploadGrammarDrafts(language, payload);
      setUploadStatus({ ok: true, message: `${result.created} ${t("draftsUploaded")}` });
      setDraftsOpen(true);
      fetchDrafts();
    } catch (e) {
      setUploadStatus({ ok: false, message: e instanceof Error ? e.message : t("draftsJsonInvalid") });
    } finally {
      setUploading(false);
    }
  }

  // One-click registration: skip the review modal and enqueue the draft as-is.
  // The queue attaches the selected group and deletes the draft only on full
  // success, so a failed add leaves the draft in place for a retry/review.
  function handleRegisterDraft(draft: GrammarDraft) {
    if (!onGrammarQueue) return;
    const isChinese = language === "chinese";
    const examples = (draft.examples ?? [])
      .filter((ex) => ex.sentence.trim())
      .map((ex) => {
        const trimmed = ex.sentence.trim();
        if (!isChinese) return { sentence: trimmed, translation: ex.translation };
        // Grammar drafts keep the user's chip splits as spaces in the sentence.
        const sentence = trimmed.replace(/[\s　]+/g, "");
        const splits = /[\s　]/.test(trimmed)
          ? (trimmed.match(/[\p{Script=Han}a-zA-Z]+/gu) ?? [])
          : [];
        return splits.length >= 2
          ? { sentence, translation: ex.translation, userSplits: splits }
          : { sentence, translation: ex.translation };
      });
    const groupName = groups.find((g) => g.id === draftGroupId)?.name;
    onGrammarQueue(
      draft.statement,
      language,
      {
        id: `grammar-${language}-${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        statement: draft.statement.trim(),
        transliteration: draft.transliteration?.trim() || undefined,
        descriptions: draft.descriptions ?? [],
        examples: examples.length > 0 ? examples : undefined,
        level: draft.level || undefined,
        tags: draft.tags && draft.tags.length > 0 ? draft.tags : undefined,
      },
      { draftId: draft.id, ...(groupName ? { groupNames: [groupName] } : {}) },
    );
  }

  async function handleDiscardDraft(draftId: string) {
    try {
      await deleteGrammarDraft(language, draftId);
    } catch {
      // draft may already be gone; refresh either way
    }
    setDiscardingDraftId(null);
    fetchDrafts();
  }

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
            disabled={uploading}
            onClick={() => jsonFileInputRef.current?.click()}
            className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50"
          >
            {uploading ? "..." : t("uploadDraftsJson")}
          </button>
          <input
            ref={jsonFileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) handleDraftsJsonFile(file);
            }}
          />
          <button
            onClick={onBack}
            className="rounded-lg border border-gray-600 px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("back")}
          </button>
        </div>
      </div>

      {uploadStatus && (
        <p className={`mb-3 text-sm ${uploadStatus.ok ? "text-green-400" : "text-red-400"}`}>
          {uploadStatus.message}
        </p>
      )}

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

      {/* OCR drafts panel */}
      {drafts.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-700/60 bg-amber-950/30">
          <div className="flex items-center gap-2 px-3 py-2">
            <button
              onClick={() => setDraftsOpen((o) => !o)}
              className="flex flex-1 items-center justify-between text-sm font-medium text-amber-200"
            >
              <span>
                {t("grammarDrafts")} ({drafts.length})
              </span>
              <span className="text-xs">{draftsOpen ? "▾" : "▸"}</span>
            </button>
            {/* Target group for the per-row "Register" button (defaults to the
                newest group). */}
            {onGrammarQueue && (
              <select
                value={draftGroupId}
                onChange={(e) => {
                  draftGroupTouchedRef.current = true;
                  setDraftGroupId(e.target.value);
                }}
                title={t("registerToGroup")}
                className="max-w-[10rem] rounded border border-amber-700/60 bg-gray-800 px-2 py-1 text-xs text-gray-200"
              >
                <option value="">{t("noGroupOption")}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {draftsOpen && (
            <div className="space-y-2 px-3 pb-3">
              {drafts.map((draft) => {
                const firstDesc = Object.values(draft.descriptions?.[0]?.text ?? {})[0] ?? "";
                const registering =
                  (grammarPendingDraftIds?.has(draft.id) || grammarPendingTerms?.has(draft.statement)) ?? false;
                return (
                  <div
                    key={draft.id}
                    className="flex items-center gap-3 rounded border border-gray-700 bg-gray-800/80 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-gray-100">
                        {draft.statement}
                        {draft.duplicate && (
                          <span className="ml-2 rounded bg-orange-900/60 px-1.5 py-0.5 align-middle text-[10px] font-medium text-orange-200">
                            {t("duplicateBadge")}
                          </span>
                        )}
                      </p>
                      {draft.transliteration && (
                        <p className="truncate text-xs text-gray-500">{draft.transliteration}</p>
                      )}
                      <p className="truncate text-xs text-gray-400">{firstDesc}</p>
                      <p className="text-xs text-gray-500">
                        {draft.sourceImage ? `${draft.sourceImage} · ` : ""}
                        {draft.createdAt ? new Date(draft.createdAt).toLocaleDateString() : ""}
                      </p>
                    </div>
                    {registering ? (
                      <span className="flex items-center gap-1 rounded border border-amber-400/60 bg-amber-900/40 px-3 py-1.5 text-xs text-amber-100">
                        <span className="animate-spin inline-block">⟳</span>
                        {t("registering")}
                      </span>
                    ) : (
                      <>
                        {onGrammarQueue && (
                          <button
                            onClick={() => handleRegisterDraft(draft)}
                            className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-500"
                          >
                            {t("registerDraft")}
                          </button>
                        )}
                        <button
                          onClick={() => setReviewingDraft(draft)}
                          className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500"
                        >
                          {t("reviewDraft")}
                        </button>
                        <button
                          onClick={() => setDiscardingDraftId(draft.id)}
                          className="rounded bg-red-900/60 px-3 py-1.5 text-xs text-red-200 hover:bg-red-800/60"
                        >
                          {t("discardDraft")}
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

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

      {/* Draft review modal — create mode with prefill.
          onDraftSave (the "Save Draft" button / Enter) writes edits back to the
          draft; the explicit "Register" button enqueues into the shared grammar
          queue (the drafts panel's selected group + draftId ride along so the
          QUEUE attaches groups and deletes the draft on success) and the modal closes immediately so the
          next draft can be reviewed. Without onGrammarQueue the modal falls back
          to awaiting smartAddGrammarItem directly, where onSave — firing only on
          success — is the delete-draft signal. */}
      {reviewingDraft && (
        <GrammarFormModal
          language={language}
          initialItem={{
            statement: reviewingDraft.statement,
            transliteration: reviewingDraft.transliteration,
            descriptions: reviewingDraft.descriptions,
            examples: reviewingDraft.examples,
            level: reviewingDraft.level,
            tags: reviewingDraft.tags,
          }}
          initialGroups={
            draftGroupId ? [groups.find((g) => g.id === draftGroupId)?.name ?? ""].filter(Boolean) : undefined
          }
          onGrammarQueue={
            onGrammarQueue
              ? (statement, lang, payload, opts) =>
                  onGrammarQueue(statement, lang, payload, { ...opts, draftId: reviewingDraft.id })
              : undefined
          }
          onDraftSave={async (updates) => {
            await updateGrammarDraft(language, reviewingDraft.id, updates);
            setReviewingDraft(null);
            fetchDrafts();
          }}
          onSave={async () => {
            await deleteGrammarDraft(language, reviewingDraft.id).catch(() => {});
            setReviewingDraft(null);
            fetchDrafts();
            fetchItems();
          }}
          onClose={() => setReviewingDraft(null)}
          onQueue={onQueue}
          pendingTerms={pendingTerms}
          succeededTerms={succeededTerms}
          refreshSignal={refreshSignal}
        />
      )}

      {/* Discard draft confirmation dialog */}
      {discardingDraftId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setDiscardingDraftId(null)}>
          <div className="rounded-xl bg-gray-800 p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <p className="mb-4 text-sm text-gray-200">{t("discardDraftConfirm")}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDiscardingDraftId(null)}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
              >
                {t("cancel")}
              </button>
              <button
                onClick={() => handleDiscardDraft(discardingDraftId)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-500"
              >
                {t("discardDraft")}
              </button>
            </div>
          </div>
        </div>
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
