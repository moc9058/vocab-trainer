import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import {
  createExpression,
  updateExpression,
  getExpressionGroups,
  modifyExpressionGroupMembers,
} from "../api/expressions";
import type { Expression, ExpressionGroup } from "../types";

interface Props {
  language: string;
  editItem?: Expression;
  onSave: () => void;
  onClose: () => void;
}

export default function ExpressionFormModal({ language, editItem, onSave, onClose }: Props) {
  const { t } = useI18n();
  const isEdit = !!editItem;

  const [phrase, setPhrase] = useState(editItem?.phrase ?? "");
  const [context, setContext] = useState(editItem?.context ?? "");
  const [description, setDescription] = useState(editItem?.description ?? "");
  const [purposeSpeaking, setPurposeSpeaking] = useState(
    editItem?.purpose?.includes("speaking") ?? false
  );
  const [purposeWriting, setPurposeWriting] = useState(
    editItem?.purpose?.includes("writing") ?? false
  );

  const [groups, setGroups] = useState<ExpressionGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getExpressionGroups(language)
      .then((loaded) => {
        setGroups(loaded);
        if (editItem?.id) {
          setSelectedGroupIds(
            new Set(loaded.filter((g) => g.expressionIds.includes(editItem.id)).map((g) => g.id))
          );
        }
      })
      .catch(() => {});
  }, [language, editItem?.id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!phrase.trim() || !context.trim()) return;

    setSaving(true);
    setError("");
    try {
      const purpose: ("speaking" | "writing")[] = [
        ...(purposeSpeaking ? (["speaking"] as const) : []),
        ...(purposeWriting ? (["writing"] as const) : []),
      ];

      let saved: Expression;
      if (isEdit && editItem) {
        saved = await updateExpression(language, editItem.id, {
          phrase: phrase.trim(),
          context: context.trim(),
          description: description.trim() || undefined,
          purpose: purpose.length > 0 ? purpose : undefined,
        });

        // Sync group membership
        const original = new Set(
          groups.filter((g) => g.expressionIds.includes(saved.id)).map((g) => g.id)
        );
        const toAdd = [...selectedGroupIds].filter((id) => !original.has(id));
        const toRemove = [...original].filter((id) => !selectedGroupIds.has(id));
        await Promise.all([
          ...toAdd.map((gid) => modifyExpressionGroupMembers(language, gid, [saved.id], "add")),
          ...toRemove.map((gid) => modifyExpressionGroupMembers(language, gid, [saved.id], "remove")),
        ]);
      } else {
        const id = `expression-${language}-${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
        saved = await createExpression(language, {
          id,
          phrase: phrase.trim(),
          context: context.trim(),
          description: description.trim() || undefined,
          purpose: purpose.length > 0 ? purpose : undefined,
        });

        // Add to selected groups
        await Promise.all(
          [...selectedGroupIds].map((gid) =>
            modifyExpressionGroupMembers(language, gid, [saved.id], "add")
          )
        );
      }

      onSave();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-gray-800 p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t(isEdit ? "editExpression" : "addExpression")}
        </h2>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Phrase */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">
              {t("expressionPhrase")} *
            </label>
            <input
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-orange-400 focus:outline-none"
            />
          </div>

          {/* Context */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">
              {t("expressionContext")} *
            </label>
            <input
              type="text"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-orange-400 focus:outline-none"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">
              {t("expressionDescription")}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-orange-400 focus:outline-none"
            />
          </div>

          {/* Purpose */}
          <div>
            <label className="mb-2 block text-sm text-gray-400">
              {t("expressionPurpose")}
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={purposeSpeaking}
                  onChange={(e) => setPurposeSpeaking(e.target.checked)}
                  className="rounded border-gray-500 bg-gray-700 text-orange-500 focus:ring-orange-400"
                />
                <span className="text-sm text-gray-300">{t("purposeSpeaking")}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={purposeWriting}
                  onChange={(e) => setPurposeWriting(e.target.checked)}
                  className="rounded border-gray-500 bg-gray-700 text-orange-500 focus:ring-orange-400"
                />
                <span className="text-sm text-gray-300">{t("purposeWriting")}</span>
              </label>
            </div>
          </div>

          {/* Groups */}
          {groups.length > 0 && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("groups")}</label>
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-600 bg-gray-700 p-2">
                {groups.map((group) => {
                  const selected = selectedGroupIds.has(group.id);
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() =>
                        setSelectedGroupIds((prev) => {
                          const next = new Set(prev);
                          selected ? next.delete(group.id) : next.add(group.id);
                          return next;
                        })
                      }
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                        selected
                          ? "bg-orange-700 text-orange-100 border border-orange-500"
                          : "border border-gray-500 text-gray-400 hover:bg-gray-600"
                      }`}
                    >
                      {group.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving || !phrase.trim() || !context.trim()}
              className="flex-1 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 disabled:opacity-50 transition-colors"
            >
              {saving ? "…" : t("save")}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
