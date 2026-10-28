import { useEffect, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { mathApi } from "./api";
import type {
  Subject,
  CurriculumNode,
  FoundationProfile,
  ScopePreview,
  ScopeRequest,
  Unit,
} from "./types";
import { useI18n } from "../i18n/context";
import CurriculumTree from "./CurriculumTree";
import MathMarkdown from "./MathMarkdown";
import { MathErrorView } from "./MathRoutes";
export default function MathTestSetup() {
  const { subjectId = "" } = useParams(),
    { t, language } = useI18n(),
    navigate = useNavigate(),
    location = useLocation();
  const [subject, setSubject] = useState<Subject | null>(null),
    [catalogId, setCatalogId] = useState(""),
    [nodes, setNodes] = useState<CurriculumNode[]>([]),
    [profiles, setProfiles] = useState<FoundationProfile[]>([]),
    [error, setError] = useState<unknown>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [unit, setUnit] = useState<Unit | null>(null),
    [preview, setPreview] = useState<
      | (ScopePreview & {
          labels?: Record<string, string>;
          prerequisitePracticeRequest?: ScopeRequest | null;
        })
      | null
    >(null),
    [accepted, setAccepted] = useState(false);
  const restored = (location.state as { scopeRequest?: ScopeRequest } | null)
    ?.scopeRequest;
  const [request, setRequest] = useState<ScopeRequest>(
    restored
      ? { ...restored, subjectId }
      : {
          subjectId,
          selectedNodeIds: [],
          excludedConceptIds: [],
          excludedObjectiveIds: [],
          objectiveCapabilities: ["recognize", "apply", "prove"],
          mode: "prerequisites",
          profileIds: [],
          difficulty: 2,
          questionCount: 5,
          responseLanguage: language,
          answerFormats: ["text"],
        },
  );
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const catalog = await mathApi.catalog();
      const s = catalog.subjects.find((s) => s.id === subjectId);
      if (!s || !catalog.activeCatalogId)
        throw new Error("MATH_SUBJECT_NOT_FOUND");
      setSubject(s);
      setCatalogId(catalog.activeCatalogId);
      let cursor: string | null = null;
      const rows: CurriculumNode[] = [];
      do {
        const response = await mathApi.nodes(
          catalog.activeCatalogId,
          subjectId,
          cursor ?? undefined,
        );
        rows.push(...response.items);
        cursor = response.nextCursor;
      } while (cursor);
      setNodes(rows);
      setProfiles((await mathApi.profiles(catalog.activeCatalogId)).profiles);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [subjectId]);
  function update(patch: Partial<ScopeRequest>) {
    setRequest((r) => ({ ...r, ...patch }));
    setPreview(null);
    setAccepted(false);
  }
  async function makePreview() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await mathApi.preview(request));
      setAccepted(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (!preview) return;
    setBusy(true);
    try {
      const test = await mathApi.create(preview);
      navigate(`/math/tests/${test.testId}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <p>{t("mathLoading")}</p>;
  return (
    <>
      <h1>{subject?.title ?? t("mathSubject")}</h1>
      {error != null && <MathErrorView error={error} retry={load} />}
      <div className="math-columns">
        <section className="math-card">
          <h2>{t("mathCurriculum")}</h2>
          {nodes.length ? (
            <CurriculumTree
              nodes={nodes}
              selected={request.selectedNodeIds}
              onChange={(selectedNodeIds) => update({ selectedNodeIds })}
              onUnit={(id) =>
                void mathApi.unit(catalogId, id).then(setUnit).catch(setError)
              }
            />
          ) : (
            <p>{t("mathEmpty")}</p>
          )}
        </section>
        <section className="math-card">
          <h2>{t("mathSetup")}</h2>
          <label>
            {t("mathDifficulty")}{" "}
            <select
              aria-label={t("mathDifficulty")}
              value={request.difficulty}
              onChange={(e) => update({ difficulty: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} · {t(`mathLevel${n}` as "mathLevel1")}
                </option>
              ))}
            </select>
          </label>
          <p className="math-muted">{t("mathDifficultyHint")}</p>
          <label>
            {t("mathQuestionCount")}{" "}
            <input
              type="number"
              min={1}
              max={20}
              value={request.questionCount}
              onChange={(e) =>
                update({ questionCount: Number(e.target.value) })
              }
            />
          </label>
          <label>
            {t("mathPolicy")}{" "}
            <select
              value={request.mode}
              onChange={(e) =>
                update({ mode: e.target.value as ScopeRequest["mode"] })
              }
            >
              <option value="strict">{t("mathStrict")}</option>
              <option value="prerequisites">{t("mathPrerequisiteMode")}</option>
              <option value="provided">{t("mathProvidedMode")}</option>
            </select>
          </label>
          <label>
            {t("mathResponseLanguage")}{" "}
            <select
              value={request.responseLanguage}
              onChange={(e) =>
                update({
                  responseLanguage: e.target
                    .value as ScopeRequest["responseLanguage"],
                })
              }
            >
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
            </select>
          </label>
          <label>
            {t("mathFormat")}{" "}
            <select
              value={request.answerFormats[0]}
              onChange={(e) =>
                update({
                  answerFormats: [
                    e.target.value as ScopeRequest["answerFormats"][number],
                  ],
                })
              }
            >
              {(
                ["text", "numeric", "expression", "proof", "choice"] as const
              ).map((f) => (
                <option key={f} value={f}>
                  {t(
                    (
                      {
                        text: "mathText",
                        numeric: "mathNumeric",
                        expression: "mathExpression",
                        proof: "mathProof",
                        choice: "mathChoice",
                      } as const
                    )[f],
                  )}
                </option>
              ))}
            </select>
          </label>
          <h2>{t("mathFoundation")}</h2>
          {profiles.length ? (
            profiles.map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  checked={request.profileIds.includes(p.id)}
                  onChange={(e) =>
                    update({
                      profileIds: e.target.checked
                        ? [...request.profileIds, p.id]
                        : request.profileIds.filter((id) => id !== p.id),
                    })
                  }
                />
                {p.title} ({p.revision})
              </label>
            ))
          ) : (
            <p className="math-muted">{t("mathNoProfiles")}</p>
          )}
          <button
            disabled={
              busy ||
              !request.selectedNodeIds.length ||
              request.questionCount < 1 ||
              request.questionCount > 20
            }
            onClick={() => void makePreview()}
          >
            {t("mathPreview")}
          </button>
        </section>
      </div>
      {unit && (
        <section className="math-card">
          <h2>{unit.title}</h2>
          <p>
            {t("mathObjectives")}: {unit.objectiveIds.length}
          </p>
          {unit.blocks.map((b) => (
            <div key={b.id}>
              <h3>{b.kind}</h3>
              <MathMarkdown>{b.markdown}</MathMarkdown>
            </div>
          ))}
          <button onClick={() => setUnit(null)}>{t("mathClose")}</button>
        </section>
      )}
      {preview && (
        <section className="math-card">
          <h2>{t("mathScopePreview")}</h2>
          <h3>{t("mathTargets")}</h3>
          <ul>
            {preview.targetObjectiveIds.map((id) => (
              <li key={id}>
                <span>{preview.labels?.[id] ?? id}</span>{" "}
                <button
                  onClick={() =>
                    update({
                      excludedObjectiveIds: [
                        ...request.excludedObjectiveIds,
                        id,
                      ],
                    })
                  }
                >
                  {t("mathExclude")}
                </button>
              </li>
            ))}
          </ul>
          <h3>{t("mathAllowedKnowledge")}</h3>
          {(["prerequisites", "baseline", "givens"] as const).map((role) => (
            <div key={role}>
              <h3>
                {t(
                  (
                    {
                      prerequisites: "mathPrerequisites",
                      baseline: "mathFoundation",
                      givens: "mathGivens",
                    } as const
                  )[role],
                )}
              </h3>
              <ul>
                {preview[role].map((r) => (
                  <li key={`${r.conceptId}:${r.capability}`}>
                    {preview.labels?.[r.conceptId] ?? r.conceptId} ·{" "}
                    {r.capability}
                    <span className="math-muted">
                      {" "}
                      {preview.paths[`${r.conceptId}:${r.capability}`]
                        ?.map(
                          (key) => preview.labels?.[key.split(":")[0]] ?? key,
                        )
                        .join(" → ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <h3>{t("mathExcluded")}</h3>
          {preview.excluded.map((o) => (
            <p key={o.objectiveId}>
              {preview.labels?.[o.objectiveId] ?? o.objectiveId} ·{" "}
              {t(
                o.reason === "MATH_DIFFICULTY_UNAVAILABLE"
                  ? "mathDifficultyUnavailable"
                  : "mathPrerequisitesMissing",
              )}{" "}
            </p>
          ))}
          {preview.prerequisitePracticeRequest && (
            <button
              onClick={() => update(preview.prerequisitePracticeRequest!)}
            >
              {t("mathPracticePrerequisites")}
            </button>
          )}
          <p>
            {t("mathCoverage")}:{" "}
            {preview.coverage.filter((c) => c.plannedQuestions > 0).length} /{" "}
            {preview.coverage.length}
          </p>
          {!preview.plans.length && (
            <p className="math-error">{t("mathScopeBlocked")}</p>
          )}
          <label>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            {t("mathAcceptScope")}
          </label>
          <p className="math-muted">{t("mathUnknownReadiness")}</p>
          <button
            disabled={busy || !accepted || !preview.plans.length}
            onClick={() => void start()}
          >
            {t("mathGenerate")}
          </button>
        </section>
      )}
    </>
  );
}
