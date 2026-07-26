import { useEffect, useState } from "react";
import { getGroups } from "../api/vocab";
import { getGrammarGroups } from "../api/grammar";
import { categoryGroups } from "../types";

interface Props {
  kind: "word" | "grammar";
  /** Backend full-name language (e.g. "chinese"), matching the group collections. */
  language: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Optional label override; defaults to "Group B". */
  label?: string;
}

/**
 * Toggle chips for the category-B groups of a language. Renders nothing when the
 * language has no Group B groups yet, so it can be dropped into every add flow
 * without cluttering setups that don't use the Group B workflow.
 *
 * Group A membership is assigned by the host form; this only ever ADDS Group B
 * memberships on top ("a Group B item is always also in Group A" is upheld by
 * the surrounding UI structure, not by server validation).
 */
export default function GroupBSelect({ kind, language, selectedIds, onChange, label }: Props) {
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load: Promise<{ id: string; name: string; category?: "A" | "B" }[]> =
      kind === "word" ? getGroups(language) : getGrammarGroups(language);
    load
      .then((gs) => {
        if (cancelled) return;
        setGroups(categoryGroups(gs, "B").map((g) => ({ id: g.id, name: g.name })));
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, language]);

  if (groups.length === 0) return null;

  const selected = new Set(selectedIds);
  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-amber-300/80">{label ?? "Group B"}:</span>
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => toggle(g.id)}
          className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
            selected.has(g.id)
              ? "border-amber-500 bg-amber-600/30 text-amber-200"
              : "border-gray-600 text-gray-400 hover:border-amber-600/60 hover:text-amber-300"
          }`}
        >
          {g.name}
        </button>
      ))}
    </div>
  );
}
