import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { ApiError } from "../api/client";
import { mathApi } from "./api";
import type { Subject, CurriculumNode, ScopeRequest, ScopeRequestV2, ScopePreviewV2, Unit } from "./types";
import { useI18n } from "../i18n/context";
import CurriculumTree, { leafSelection, selectableLeaves } from "./CurriculumTree";
import MathMarkdown from "./MathMarkdown";
import { MathErrorView } from "./MathRoutes";

export function parseQuestionCount(value: string): number | undefined | false {
  if (!value.trim()) return undefined;
  if (!/^\d+$/.test(value)) return false;
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 20 ? count : false;
}
export default function MathTestSetup() {
  const { subjectId = "" } = useParams(), { t, language } = useI18n(), navigate = useNavigate(), location = useLocation();
  const restored = (location.state as { scopeRequest?: ScopeRequest | ScopeRequestV2 } | null)?.scopeRequest;
  const [subject, setSubject] = useState<Subject | null>(null);
  const [catalogId, setCatalogId] = useState("");
  const [nodes, setNodes] = useState<CurriculumNode[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unit, setUnit] = useState<Unit | null>(null);
  const [catalogChanged, setCatalogChanged] = useState(false);
  // Historic policies are never copied into a new v2 request.
  const [selected, setSelected] = useState<string[]>(restored?.selectedNodeIds ?? []);
  const [difficulty, setDifficulty] = useState(restored?.difficulty ?? 2);
  const [countText, setCountText] = useState(restored?.questionCount?.toString() ?? "");
  const pendingCreate = useRef<{ fingerprint: string; preview: ScopePreviewV2 } | null>(null);
  async function load() {
    setLoading(true);
    try {
      const catalog = await mathApi.catalog();
      const current = catalog.subjects.find((s) => s.id === subjectId);
      if (!current || !catalog.activeCatalogId) throw new Error("MATH_SUBJECT_NOT_FOUND");
      setSubject(current); setCatalogId(catalog.activeCatalogId);
      let cursor: string | null = null;
      const rows: CurriculumNode[] = [];
      do {
        const response = await mathApi.nodes(catalog.activeCatalogId, subjectId, cursor ?? undefined);
        rows.push(...response.items); cursor = response.nextCursor;
      } while (cursor);
      setNodes(rows);
      setSelected((old) => leafSelection(rows, old));
    } catch (e) { setError(e); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [subjectId]);
  const count = parseQuestionCount(countText);
  const selectedLeaves = selectableLeaves(nodes).filter((n) => selected.includes(n.id));
  const chapters = new Set(selectedLeaves.flatMap((leaf) => [leaf.id, ...leaf.ancestorIds]
    .filter((id) => nodes.some((n) => n.id === id && n.kind === "chapter"))));
  async function start() {
    if (count === false || !selectedLeaves.length) return;
    setBusy(true); setError(null); setCatalogChanged(false);
    try {
      const request: ScopeRequestV2 = { schemaVersion: 2, subjectId,
        selectedNodeIds: selectedLeaves.map((n) => n.id), difficulty: difficulty as ScopeRequestV2["difficulty"],
        responseLanguage: language, ...(count === undefined ? {} : { questionCount: count }) };
      const fingerprint = JSON.stringify(request);
      const preview = pendingCreate.current?.fingerprint === fingerprint
        ? pendingCreate.current.preview : await mathApi.preview(request);
      pendingCreate.current = { fingerprint, preview };
      if (preview.catalogId !== catalogId) throw new ApiError(409, "MATH_CATALOG_CHANGED");
      if (!preview.eligibleObjectiveCount) throw new ApiError(400, "MATH_SCOPE_BLOCKED");
      const test = await mathApi.create(preview);
      navigate(`/math/tests/${test.testId}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { pendingCreate.current = null; await load(); setCatalogChanged(true); }
      else setError(e);
    } finally { setBusy(false); }
  }
  if (loading) return <p>{t("mathLoading")}</p>;
  return <div className="math-setup">
    <h1>{subject?.title ?? t("mathSubject")}</h1>
    {error != null && <MathErrorView error={error} retry={load} />}
    {catalogChanged && <p role="alert" className="math-error">{t("mathCatalogChanged")}</p>}
    <section aria-labelledby="math-range-heading">
      <h2 id="math-range-heading">{t("mathCurriculum")}</h2>
      {nodes.length ? <CurriculumTree nodes={nodes} selected={selected} onChange={setSelected}
        onUnit={(id) => void mathApi.unit(catalogId, id).then(setUnit).catch(setError)} /> : <p>{t("mathEmpty")}</p>}
      <p className="math-muted" aria-live="polite">{t("mathSelected")}: {chapters.size} {t("mathChapters")} · {selectedLeaves.length} {t("mathItems")}</p>
      <p className="math-muted">{t("mathAutomaticPrerequisites")}</p>
    </section>
    <section className="math-setup-controls">
      <label htmlFor="math-difficulty">{t("mathDifficulty")}</label>
      <select id="math-difficulty" value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))}>
        {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} · {t(`mathLevel${n}` as "mathLevel1")}</option>)}
      </select>
      <p className="math-muted">{t("mathDifficultyHint")}</p>
      <label htmlFor="math-count">{t("mathQuestionCount")}</label>
      <input id="math-count" className="math-count-input" type="text" inputMode="numeric" autoComplete="off"
        value={countText} aria-describedby="math-count-hint" aria-invalid={count === false}
        onChange={(e) => setCountText(e.target.value)} />
      <p id="math-count-hint" className={count === false ? "math-error" : "math-muted"}>{t(count === false ? "mathQuestionCountInvalid" : "mathContinuousHint")}</p>
      <button className="math-primary-button" disabled={busy || !selectedLeaves.length || count === false}
        onClick={() => void start()}>{t(busy ? "mathGenerating" : "mathStart")}</button>
    </section>
    {unit && <section className="math-card" aria-label={t("mathBrowse")}>
      <h2>{unit.title}</h2>
      <p>{t("mathObjectives")}: {unit.objectiveIds.length}</p>
      {unit.blocks.map((b) => <MathMarkdown key={b.id}>{b.markdown}</MathMarkdown>)}
      <button onClick={() => setUnit(null)}>{t("mathClose")}</button>
    </section>}
  </div>;
}
