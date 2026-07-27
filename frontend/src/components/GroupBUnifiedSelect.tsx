import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { createGroupBGroup, loadGroupBGroups, type UnifiedGroupB } from "../utils/groupB";

interface Props {
  /** Backend full-name language (e.g. "chinese"), matching the group collections. */
  language: string;
  /** Selected group NAMES — a Group B group is identified by name across both domains. */
  selectedNames: string[];
  onChange: (names: string[]) => void;
}

/**
 * Picker for Group B groups as single study sets spanning words + grammar.
 * Selection is by name (see `utils/groupB.ts`), and a new group can be created
 * inline so the whole "paste article → choose destination" flow stays on one screen.
 */
export default function GroupBUnifiedSelect({ language, selectedNames, onChange }: Props) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<UnifiedGroupB[]>([]);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadGroupBGroups(language)
      .then((gs) => { if (!cancelled) setGroups(gs); })
      .catch(() => { if (!cancelled) setGroups([]); });
    return () => { cancelled = true; };
  }, [language]);

  const selected = new Set(selectedNames);

  function toggle(name: string) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange([...next]);
  }

  async function handleCreate() {
    const name = draftName.trim();
    if (!name || busy) return;
    if (groups.some((g) => g.name === name)) {
      onChange([...new Set([...selectedNames, name])]);
      setCreating(false);
      setDraftName("");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createGroupBGroup(language, name);
      setGroups((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      onChange([...new Set([...selectedNames, name])]);
      setCreating(false);
      setDraftName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => {
          const isSelected = selected.has(g.name);
          return (
            <button
              key={g.name}
              type="button"
              onClick={() => toggle(g.name)}
              aria-pressed={isSelected}
              className={`rounded-full border px-3 py-1 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                isSelected
                  ? "border-amber-500 bg-amber-500/20 text-amber-200"
                  : "border-gray-600 text-gray-400 hover:border-amber-600/60 hover:text-amber-300"
              }`}
            >
              {isSelected && <span className="mr-1">✓</span>}
              {g.name}
            </button>
          );
        })}

        {creating ? (
          <span className="inline-flex items-center gap-1">
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); handleCreate(); }
                if (e.key === "Escape") { setCreating(false); setDraftName(""); }
              }}
              placeholder={t("groupName")}
              className="w-36 rounded-full border border-amber-600/60 bg-gray-900 px-3 py-1 text-xs text-amber-100 placeholder-gray-500 focus:border-amber-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={!draftName.trim() || busy}
              className="rounded-full bg-amber-600/80 px-2.5 py-1 text-xs text-white hover:bg-amber-500 disabled:opacity-40"
            >
              {busy ? "…" : t("save")}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-full border border-dashed border-gray-600 px-3 py-1 text-xs text-gray-400 hover:border-amber-600/60 hover:text-amber-300"
          >
            + {t("importNewGroupB")}
          </button>
        )}
      </div>

      {groups.length === 0 && !creating && (
        <p className="text-xs text-gray-500">{t("importNoGroupB")}</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
