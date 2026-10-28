import { useState, useRef, useEffect } from "react";
import type { CurriculumNode } from "./types";
import { useI18n } from "../i18n/context";

/** Only selectable leaves are persisted; parents are derived tri-state controls. */
export function selectableLeaves(nodes: CurriculumNode[]) {
  return nodes.filter((node) => !nodes.some((child) => child.parentId === node.id) &&
    (node.eligibleObjectiveCount ?? node.unitIds.length) > 0);
}
export function leafSelection(nodes: CurriculumNode[], selected: string[]) {
  const leaves = selectableLeaves(nodes);
  return leaves.filter((leaf) => selected.includes(leaf.id) || leaf.ancestorIds.some((id) => selected.includes(id))).map((leaf) => leaf.id);
}
export default function CurriculumTree({ nodes, selected, onChange, onUnit }: {
  nodes: CurriculumNode[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onUnit: (id: string) => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState<string>("");
  const leaves = selectableLeaves(nodes);
  const canonical = leafSelection(nodes, selected);
  function descendantLeaves(node: CurriculumNode) {
    return leaves.filter((n) => n.id === node.id || n.ancestorIds.includes(node.id));
  }
  function toggle(node: CurriculumNode, checked: boolean) {
    const ids = descendantLeaves(node).map((n) => n.id);
    onChange(checked ? [...new Set([...canonical, ...ids])] : canonical.filter((id) => !ids.includes(id)));
  }
  function render(parentId: string | null) {
    return nodes.filter((n) => n.parentId === parentId)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((n) => {
        const child = nodes.some((c) => c.parentId === n.id);
        const descendants = descendantLeaves(n);
        const checked = descendants.length > 0 && descendants.every((d) => canonical.includes(d.id));
        const partial = !checked && descendants.some((d) => canonical.includes(d.id));
        const expanded = !collapsed.includes(n.id);
        return <li key={n.id}>
          <div className={`math-tree-row${checked || partial ? " math-tree-selected" : ""}`}>
            {child ? <button className="math-icon-button" type="button"
              aria-label={`${expanded ? t("mathCollapse") : t("mathExpand")} ${n.title}`}
              aria-expanded={expanded}
              onClick={() => setCollapsed((previous) => expanded ? [...previous, n.id] : previous.filter((id) => id !== n.id))}>
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            </button> : <span className="math-tree-spacer" aria-hidden="true" />}
            <label className="math-tree-label">
              <TreeCheckbox checked={checked} partial={partial} disabled={!descendants.length}
                onChange={(value) => toggle(n, value)} />
              <span>{n.title}{!descendants.length && <small className="math-muted"> · {t("mathNoSelectableObjectives")}</small>}</span>
            </label>
            <span className="math-tree-count math-muted" aria-label={t("mathUnits")}>{descendants.length}</span>
            {n.unitIds.length > 0 && <button className="math-icon-button" type="button"
              aria-label={`${t("mathBrowse")} ${n.title}`} aria-pressed={browsing === n.id}
              onClick={() => { setBrowsing(n.id); onUnit(n.unitIds[0]); }}>↗</button>}
          </div>
          {child && expanded && <ul>{render(n.id)}</ul>}
        </li>;
      });
  }
  return <div className="math-tree">
    <div className="math-tree-toolbar">
      <button className="math-secondary-button" onClick={() => onChange(leaves.map((node) => node.id))}>{t("mathSelectAll")}</button>
      <button className="math-secondary-button" onClick={() => onChange([])}>{t("mathClearSelection")}</button>
    </div>
    <ul aria-label={t("mathCurriculum")}>{render(null)}</ul>
  </div>;
}
function TreeCheckbox({ checked, partial, disabled, onChange }: {
  checked: boolean; partial: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled}
    aria-checked={partial ? "mixed" : checked} onChange={(e) => onChange(e.target.checked)} />;
}
