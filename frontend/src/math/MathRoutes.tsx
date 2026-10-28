import { useEffect, useState } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { useI18n } from "../i18n/context";
import { ApiError } from "../api/client";
import { mathApi } from "./api";
import type { Subject, MathTest, Concept } from "./types";
import MathTestSetup from "./MathTestSetup";
import MathTestTaking from "./MathTestTaking";
import MathMarkdown from "./MathMarkdown";
import { MathCitation } from "./MathCitation";
import "./math.css";
export function MathErrorView({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const { t } = useI18n();
  const code = error instanceof ApiError ? error.code : undefined;
  const label =
    error instanceof ApiError && error.status === 404
      ? "mathNotFound"
      : error instanceof ApiError && error.status === 409
        ? "mathConflict"
        : code === "MATH_WORKER_UNAVAILABLE"
          ? "mathWorkerUnavailable"
          : code === "MATH_MODEL_UNAVAILABLE"
            ? "mathModelUnavailable"
            : code === "MATH_SCOPE_BLOCKED"
              ? "mathScopeBlocked"
              : code === "MATH_CONTEXT_TOO_LARGE"
                ? "mathContextTooLarge"
                : "mathError";
  return (
    <div role="alert" className="math-error">
      <p>{t(label)}</p>
      {retry && <button onClick={retry}>{t("mathRetry")}</button>}
    </div>
  );
}
function MathHome() {
  const { t } = useI18n();
  const [subjects, setSubjects] = useState<Subject[]>([]),
    [tests, setTests] = useState<MathTest[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null),
    [worker, setWorker] = useState(true);
  async function load() {
    setLoading(true);
    const results = await Promise.allSettled([
      mathApi.catalog(),
      mathApi.tests(),
    ]);
    if (results[0].status === "fulfilled") {
      setSubjects(results[0].value.subjects);
      setWorker(results[0].value.capabilities.generate);
    } else setError(results[0].reason);
    if (results[1].status === "fulfilled") {
      setTests(results[1].value.items);
      setCursor(results[1].value.nextCursor);
    } else setError(results[1].reason);
    setLoading(false);
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <h1>{t("mathTitle")}</h1>
      <p>{t("mathIntro")}</p>
      <p className="math-muted">{t("mathSharedLearner")}</p>
      {error != null && <MathErrorView error={error} retry={load} />}
      <h2>{t("mathSubjects")}</h2>
      {loading ? (
        <p>{t("mathLoading")}</p>
      ) : subjects.length ? (
        subjects
          .sort((a, b) => a.order - b.order)
          .map((s) => (
            <section className="math-card" key={s.id}>
              <Link to={`/math/subjects/${s.id}`}>{s.title}</Link>
            </section>
          ))
      ) : (
        <section className="math-card">
          <h2>{t("mathEmpty")}</h2>
          <p>{t("mathEmptyHint")}</p>
        </section>
      )}
      {!worker && <p className="math-error">{t("mathWorkerUnavailable")}</p>}
      <h2>{t("mathHistory")}</h2>
      {tests.length ? (
        tests.map((test) => (
          <section className="math-card" key={test.id}>
            {test.purpose === "verification" && (
              <p className="math-muted">{t("mathVerification")}</p>
            )}
            <Link to={`/math/tests/${test.id}`}>
              {subjects.find((s) => s.id === test.config.subjectId)?.title ??
                t("mathTest")}{" "}
              · {new Date(test.createdAt).toLocaleString()} ·{" "}
              {t(
                (
                  {
                    generating: "mathGenerating",
                    generation_failed: "mathGenerationFailed",
                    ready: "mathReady",
                    in_progress: "mathInProgress",
                    completed: "mathCompleted",
                    cancelled: "mathCancelled",
                  } as const
                )[test.state],
              )}
            </Link>
            <p>
              {test.answeredCount ?? test.answeredQuestionIds.length} /{" "}
              {test.schemaVersion === 2 ? (test.questionLimit ?? t("mathContinuous")) : (test.questionIds.length || test.config.questionCount)}
            </p>
          </section>
        ))
      ) : (
        <p className="math-muted">{t("mathNoTests")}</p>
      )}
      {cursor && (
        <button
          onClick={() =>
            void mathApi
              .tests(undefined, cursor)
              .then((page) => {
                setTests((rows) => [...rows, ...page.items]);
                setCursor(page.nextCursor);
              })
              .catch(setError)
          }
        >
          {t("mathLoadMore")}
        </button>
      )}
    </>
  );
}
function ConceptView() {
  const { catalogId = "", conceptId = "" } = useParams(),
    { t } = useI18n();
  const [concept, setConcept] = useState<Concept | null>(null),
    [learning, setLearning] = useState<Awaited<
      ReturnType<typeof mathApi.learningState>
    > | null>(null),
    [error, setError] = useState<unknown>(null);
  const load = () => {
    void mathApi.concept(catalogId, conceptId).then(setConcept).catch(setError);
    void mathApi.learningState(conceptId).then(setLearning).catch(setError);
  };
  useEffect(load, [catalogId, conceptId]);
  return error != null ? (
    <MathErrorView error={error} retry={load} />
  ) : !concept ? (
    <p>{t("mathLoading")}</p>
  ) : (
    <>
      <h1>{concept.title}</h1>
      <p className="math-muted">{t("mathFixedRevision")}</p>
      <h2>{t("mathStatement")}</h2>
      <MathMarkdown>{concept.statement}</MathMarkdown>
      <h2>{t("mathConditions")}</h2>
      <MathMarkdown>{concept.conditions}</MathMarkdown>
      <h2>{t("mathSources")}</h2>
      {concept.citations.map((c) => (
        <MathCitation key={c.citationId} citation={c} catalogId={catalogId} />
      ))}
      <section className="math-card">
        <h2>{t("mathReadiness")}</h2>
        <p className="math-muted">{t("mathUnknownReadiness")}</p>
        {(["known", "needs-review", "unknown"] as const).map((readiness) => (
          <button
            key={readiness}
            aria-pressed={
              (learning?.state?.selfDeclaredReadiness ?? "unknown") ===
              readiness
            }
            onClick={() =>
              void mathApi
                .readiness(
                  catalogId,
                  conceptId,
                  readiness,
                  learning?.state?.revision ?? 0,
                )
                .then(() => mathApi.learningState(conceptId))
                .then(setLearning)
                .catch(setError)
            }
          >
            {t(
              (
                {
                  known: "mathKnown",
                  "needs-review": "mathNeedsReview",
                  unknown: "mathUnknown",
                } as const
              )[readiness],
            )}
          </button>
        ))}
        <p>
          {t("mathCurrentEvidence")}:{" "}
          {learning?.items.filter(
            (e) =>
              e.valid &&
              e.demonstrated &&
              e.conceptRevisionId === concept.revisionId,
          ).length ?? 0}
        </p>
        <p className="math-muted">
          {t("mathOlderEvidence")}:{" "}
          {learning?.items.filter(
            (e) => e.conceptRevisionId !== concept.revisionId,
          ).length ?? 0}
        </p>
      </section>
    </>
  );
}
function SubjectRoute() {
  const { subjectId } = useParams();
  return <MathTestSetup key={subjectId} />;
}
function TestRoute() {
  const { testId } = useParams();
  return <MathTestTaking key={testId} />;
}
export default function MathRoutes() {
  const { t } = useI18n();
  return (
    <main className="math-page">
      <nav>
        <Link to="/">← {t("mathCategories")}</Link> ·{" "}
        <Link to="/math">{t("mathTitle")}</Link>
      </nav>
      <Routes>
        <Route index element={<MathHome />} />
        <Route path="subjects/:subjectId" element={<SubjectRoute />} />
        <Route path="tests/:testId" element={<TestRoute />} />
        <Route
          path="catalogs/:catalogId/concepts/:conceptId"
          element={<ConceptView />}
        />
        <Route path="*" element={<p role="alert">{t("mathNotFound")}</p>} />
      </Routes>
    </main>
  );
}
