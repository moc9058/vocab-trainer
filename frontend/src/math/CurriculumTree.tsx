import { useState, useRef, useEffect } from "react";
import type { CurriculumNode } from "./types";
import { useI18n } from "../i18n/context";
export default function CurriculumTree({
  nodes,
  selected,
  onChange,
  onUnit,
}: {
  nodes: CurriculumNode[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onUnit: (id: string) => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<string[]>([]),
    [search, setSearch] = useState("");
  function descendants(node: CurriculumNode) {
    return nodes.filter(
      (n) => n.id === node.id || n.ancestorIds.includes(node.id),
    );
  }
  function toggle(node: CurriculumNode, checked: boolean) {
    const ids = descendants(node).map((n) => n.id);
    onChange(
      checked
        ? [...new Set([...selected, ...ids])]
        : selected.filter(
            (id) => !ids.includes(id) && !node.ancestorIds.includes(id),
          ),
    );
  }
  function render(parentId: string | null) {
    return nodes
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .filter(
        (n) =>
          !search ||
          descendants(n).some((d) =>
            d.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
          ),
      )
      .map((n) => {
        const child = nodes.some((c) => c.parentId === n.id),
          all = descendants(n),
          checked = all.every((d) => selected.includes(d.id)),
          partial = !checked && all.some((d) => selected.includes(d.id)),
          expanded = !collapsed.includes(n.id);
        return (
          <li
            key={n.id}
            role="treeitem"
            aria-expanded={child ? expanded : undefined}
            aria-checked={partial ? "mixed" : checked}
          >
            <div>
              <button
                aria-label={`${expanded ? t("mathCollapse") : t("mathExpand")} ${n.title}`}
                disabled={!child}
                onClick={() =>
                  setCollapsed((previous) =>
                    expanded
                      ? [...previous, n.id]
                      : previous.filter((id) => id !== n.id),
                  )
                }
              >
                {child ? (expanded ? "−" : "+") : "·"}
              </button>
              <label>
                <TreeCheckbox
                  checked={checked}
                  partial={partial}
                  onChange={(checked) => toggle(n, checked)}
                />
                {n.title}{" "}
                <span className="math-muted">
                  ({all.reduce((sum, d) => sum + d.unitIds.length, 0)}{" "}
                  {t("mathUnits")})
                </span>
              </label>
              {n.unitIds.map((id) => (
                <button key={id} onClick={() => onUnit(id)}>
                  {t("mathBrowse")}
                </button>
              ))}
            </div>
            {child && expanded && <ul role="group">{render(n.id)}</ul>}
          </li>
        );
      });
  }
  return (
    <div className="math-tree">
      <label>
        {t("mathSearch")}
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <ul role="tree" aria-label={t("mathCurriculum")}>
        {render(null)}
      </ul>
    </div>
  );
}
function TreeCheckbox({
  checked,
  partial,
  onChange,
}: {
  checked: boolean;
  partial: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-checked={partial ? "mixed" : checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
