import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useI18n } from "../i18n/context";
import { useAnswerOutbox } from "../hooks/useAnswerOutbox";
import { useCaptureNavigationBlocker } from "../hooks/useCaptureNavigation";
import { resolveMathConflict } from "../utils/answerOutbox";
import { mathApi, queueMathOperation } from "./api";
import type { TestView, StoredSolution, Attempt } from "./types";
import MathMarkdown from "./MathMarkdown";
import { MathCitation, MathSolutionView } from "./MathCitation";
import { MathErrorView } from "./MathRoutes";
const memoryDrafts = new Map<string, string>(),
  pendingQuestions = new Map<string, Set<string>>();
export default function MathTestTaking() {
  const { testId = "" } = useParams(),
    { t } = useI18n(),
    outbox = useAnswerOutbox();
  const [view, setView] = useState<TestView | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [text, setText] = useState(""),
    [dirty, setDirty] = useState(false),
    [hints, setHints] = useState<Record<string, string>>({}),
    [solutions, setSolutions] = useState<Record<string, StoredSolution>>({}),
    [selected, setSelected] = useState<string | null>(null),
    [localEpoch, setLocalEpoch] = useState(0),
    [showScope, setShowScope] = useState(false),
    [scopeRows, setScopeRows] = useState<
      { role: string; ref: { conceptId: string; capability: string } }[]
    >([]),
    [report, setReport] = useState(""),
    [reportReason, setReportReason] = useState("incorrect-answer"),
    [scores, setScores] = useState<Record<string, number>>({}),
    [history, setHistory] = useState<Attempt[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyPage, setHistoryPage] = useState<string | undefined>(undefined),
    [jobError, setJobError] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const load = useCallback(async () => {
    try {
      const result = await mathApi.test(testId);
      setView(result);
      setError(null);
      if (result.schemaVersion === 2) {
        const page = await mathApi.attempts(testId, historyPage);
        setHistory(page.items);
        setHistoryCursor(page.nextCursor);
      }
      if (result.state === "generation_failed" || result.generationState === "failed") {
        const job = await mathApi.job(result.pendingGenerationJobId ?? result.generationJobId);
        setJobError(job.lastError);
      }
    } catch (e) {
      setError(e);
    }
  }, [testId, historyPage]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  const pending = pendingQuestions.get(testId) ?? new Set<string>();
  const question = view?.questions.find(
    (q) =>
      (view.schemaVersion === 2 ? q.id === view.currentQuestionId : !view.answeredQuestionIds.includes(q.id)) &&
      !view.invalidQuestionIds.includes(q.id) &&
      !pending.has(q.id),
  );
  const questionId = question?.id ?? null,
    answerRef = useRef({
      questionId: null as string | null,
      text: "",
      dirty: false,
    });
  const key = questionId ? `${testId}/${questionId}` : "";
  const queueDraft = useCallback(
    (questionId: string, answer: string) => {
      return queueMathOperation(
        testId,
        "draft",
        { text: answer },
        { questionId },
      )
        .then((result) => {
          const k = `${testId}/${questionId}`;
          if (memoryDrafts.get(k) === answer) memoryDrafts.delete(k);
          if (
            answerRef.current.questionId === questionId &&
            answerRef.current.text === answer
          ) {
            answerRef.current.dirty = false;
            setDirty(false);
          }
          return result;
        })
        .catch(setError);
    },
    [testId],
  );
  useEffect(() => {
    const current = questionId
      ? (memoryDrafts.get(`${testId}/${questionId}`) ??
        viewRef.current?.drafts.find((d) => d.questionId === questionId)
          ?.answerText ??
        "")
      : "";
    setText(current);
    const unsaved = !!questionId && memoryDrafts.has(`${testId}/${questionId}`);
    setDirty(unsaved);
    answerRef.current = { questionId, text: current, dirty: unsaved };
    setScores({});
  }, [questionId, testId]);
  useEffect(() => {
    if (!dirty || !questionId) return;
    const timer = setTimeout(() => {
      answerRef.current.dirty = false;
      void queueDraft(questionId, answerRef.current.text);
    }, 650);
    return () => clearTimeout(timer);
  }, [text, dirty, questionId, queueDraft]);
  useEffect(
    () => () => {
      const current = answerRef.current;
      if (current.questionId && current.dirty) {
        current.dirty = false;
        void queueDraft(current.questionId, current.text);
      }
    },
    [queueDraft],
  );
  useCaptureNavigationBlocker(dirty || busy);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function edit(value: string) {
    setText(value);
    setDirty(true);
    memoryDrafts.set(key, value);
    answerRef.current = { questionId, text: value, dirty: true };
  }
  function flushDraft() {
    const current = answerRef.current;
    if (current.questionId && current.dirty) {
      current.dirty = false;
      void queueDraft(current.questionId, current.text);
    }
  }
  async function mutate(
    action: string,
    body: Record<string, unknown> = {},
    options: { questionId?: string; attemptId?: string } = {},
  ) {
    flushDraft();
    setBusy(true);
    setError(null);
    try {
      const result = await queueMathOperation(testId, action, body, options);
      if (result.solution) {
        const id = (body.questionId ?? options.questionId) as string;
        setSolutions((previous) => ({ ...previous, [id]: result.solution }));
      }
      if (result.hintMarkdown)
        setHints((previous) => ({
          ...previous,
          [body.questionId as string]: result.hintMarkdown,
        }));
      await load();
      return result;
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function submit(paper = false, skip = false) {
    if (!view || !questionId) return;
    flushDraft();
    const id = questionId;
    const ids = pendingQuestions.get(testId) ?? new Set<string>();
    ids.add(id);
    pendingQuestions.set(testId, ids);
    setLocalEpoch((n) => n + 1);
    void queueMathOperation(
      testId,
      skip ? "skip" : "attempts",
      skip
        ? { questionId: id, reason: "" }
        : {
            questionId: id,
            sittingId: view.currentSittingId,
            answerText: text,
            paper,
          },
    )
      .then(() => {
        ids.delete(id);
        memoryDrafts.delete(`${testId}/${id}`);
        setLocalEpoch((n) => n + 1);
        void load();
      })
      .catch(setError);
  }
  async function openScope() {
    setShowScope(true);
    try {
      let cursor: string | null = null;
      const rows: typeof scopeRows = [];
      do {
        const page = await mathApi.scope(testId, cursor ?? undefined);
        rows.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      setScopeRows(rows);
    } catch (e) {
      setError(e);
    }
  }
  const attempts = view ? [...new Map([...history, ...view.attempts].map((a) => [a.id, a])).values()] : [];
  const review = view?.sitting?.review,
    reviewAttempt =
      review?.state === "active"
        ? attempts.find((a) => a.id === (review.currentAttemptId ?? review.attemptIds[review.cursor]))
        : null;
  const selectedAttempt =
      reviewAttempt ?? attempts.find((a) => a.id === selected),
    selectedQuestion = selectedAttempt?.questionId ?? null;
  const autoReveal = useRef("");
  useEffect(() => {
    if (reviewAttempt && autoReveal.current !== reviewAttempt.id) {
      autoReveal.current = reviewAttempt.id;
      void mutate("reveal", { questionId: reviewAttempt.questionId });
    }
  }, [reviewAttempt?.id]);
  if (!view)
    return (
      <>
        {error != null ? (
          <MathErrorView error={error} retry={load} />
        ) : (
          <p>{t("mathLoading")}</p>
        )}
      </>
    );
  const currentSolution = selectedQuestion ? solutions[selectedQuestion] : null;
  return (
    <>
      <h1>{t("mathTest")}</h1>
      {view.purpose === "verification" && (
        <p className="math-muted">{t("mathVerification")}</p>
      )}
      <div className="math-status">
        <span>
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
            )[view.state],
          )}
        </span>
        <span>
          {view.answeredCount ?? view.answeredQuestionIds.length} /{" "}
          {view.schemaVersion === 2 ? (view.questionLimit ?? t("mathContinuous")) : (view.questionIds.length || view.config.questionCount)}
        </span>
        <span>
          {outbox.pending || dirty ? t("mathUnsaved") : t("mathSaved")}
        </span>
        <button onClick={() => void openScope()}>{t("mathScope")}</button>
      </div>
      {error != null && <MathErrorView error={error} retry={load} />}
      {outbox.conflictBlocked && (
        <div className="math-error">
          <p>{t("mathConflict")}</p>
          <p>{t("mathConflictKeepText")}</p>
          <button
            onClick={() =>
              void resolveMathConflict(true).then(load).catch(setError)
            }
          >
            {t("mathRetryLocal")}
          </button>
          <button
            onClick={() => {
              if (window.confirm(t("mathDiscardConfirm")))
                void resolveMathConflict(false)
                  .then(() => {
                    pendingQuestions.get(testId)?.clear();
                    void load();
                  })
                  .catch(setError);
            }}
          >
            {t("mathUseSaved")}
          </button>
        </div>
      )}
      {showScope && (
        <section className="math-card">
          <h2>{t("mathScope")}</h2>
          {scopeRows.map((r, i) => (
            <p key={i}>
              {t(
                (
                  {
                    target: "mathTargets",
                    prerequisite: "mathPrerequisites",
                    baseline: "mathFoundation",
                    given: "mathGivens",
                  } as const
                )[r.role as "target"],
              )}{" "}
              ·{" "}
              <Link
                to={`/math/catalogs/${view.catalogId}/concepts/${r.ref.conceptId}`}
              >
                {r.ref.conceptId}
              </Link>{" "}
              · {r.ref.capability}
            </p>
          ))}
          <button onClick={() => setShowScope(false)}>{t("mathClose")}</button>
        </section>
      )}
      {view.state === "generating" && (
        <section className="math-card">
          <p>{t("mathGeneratingHint")}</p>
          <p>
            {view.generatedCount ?? view.questionIds.length} / {view.questionLimit ?? view.config.questionCount ?? t("mathContinuous")}
          </p>
          <button disabled={busy} onClick={() => void mutate("cancel")}>
            {t("mathCancel")}
          </button>
        </section>
      )}
      {(view.state === "generation_failed" || view.generationState === "failed") && (
        <section className="math-card">
          <p>
            {t("mathGenerationFailed")} · {view.generatedCount ?? view.questionIds.length} /{" "}
            {view.questionLimit ?? view.config.questionCount ?? t("mathContinuous")}
          </p>
          {jobError && (
            <p className="math-muted">
              {t(
                jobError === "MATH_JOB_VERSION_UNSUPPORTED"
                  ? "mathUnsupportedVersion"
                  : jobError === "MATH_MODEL_UNAVAILABLE"
                    ? "mathModelUnavailable"
                    : jobError === "MATH_JOB_BUDGET"
                      ? "mathBudgetExceeded"
                      : "mathValidationFailed",
              )}
            </p>
          )}
          <button
            disabled={busy || jobError === "MATH_JOB_VERSION_UNSUPPORTED"}
            onClick={() => void mutate(view.schemaVersion === 2 ? "next-question" : "retry-generation")}
          >
            {t("mathRetryGeneration")}
          </button>
          <Link
            state={{ scopeRequest: view.config }}
            to={`/math/subjects/${view.config.subjectId}`}
          >
            {t("mathNewTestFromScope")}
          </Link>
          {view.schemaVersion === 1 && <button
            disabled={busy || !view.questionIds.length}
            onClick={() =>
              void mutate("accept-partial", {
                acceptedQuestionIds: view.questionIds,
              })
            }
          >
            {t("mathAcceptPartial")}
          </button>}
          <button disabled={busy} onClick={() => void mutate("cancel")}>
            {t("mathCancel")}
          </button>
        </section>
      )}
      {view.state === "ready" && (
        <button disabled={busy} onClick={() => void mutate("start")}>
          {t("mathStart")}
        </button>
      )}
      {view.state === "in_progress" &&
        view.sitting?.state === "active" &&
        question && (
          <section className="math-card" key={question.id}>
            <p className="math-muted">
              {t("mathQuestion")} {question.ordinal} · {t("mathDifficulty")}{" "}
              {question.difficulty} · {t("mathAIValidated")}
            </p>
            <MathMarkdown>{question.promptMarkdown}</MathMarkdown>
            <label>
              {t("mathYourAnswer")}
              <textarea
                value={text}
                onChange={(e) => edit(e.target.value)}
                placeholder={t("mathAnswerHint")}
              />
            </label>
            <details>
              <summary>{t("mathAnswerPreview")}</summary>
              <MathMarkdown>{text}</MathMarkdown>
            </details>
            <button
              disabled={!text.trim() || outbox.conflictBlocked}
              onClick={() => submit()}
            >
              {t("mathSubmit")}
            </button>
            <button
              disabled={outbox.conflictBlocked}
              onClick={() => submit(true)}
            >
              {t("mathPaper")}
            </button>
            <button
              disabled={outbox.conflictBlocked}
              onClick={() => submit(false, true)}
            >
              {t("mathSkip")}
            </button>
            <button
              disabled={busy}
              onClick={() => void mutate("reveal", { questionId: question.id })}
            >
              {t("mathReveal")}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void mutate("reveal", { questionId: question.id, hint: true })
              }
            >
              {t("mathHint")}
            </button>
            {hints[question.id] && (
              <div className="math-card">
                <h2>{t("mathHint")}</h2>
                <MathMarkdown>{hints[question.id]}</MathMarkdown>
              </div>
            )}
            {solutions[question.id] && (
              <MathSolutionView
                solution={solutions[question.id]}
                catalogId={view.catalogId}
              />
            )}
          </section>
        )}
      {view.schemaVersion === 2 && view.state === "in_progress" && view.sitting?.state === "active" && !question && (
        <section className="math-card">
          {view.generationState === "queued" || view.generationState === "running" ?
            <p role="status">{t("mathLoadingNext")}</p> :
            <button className="math-primary-button" disabled={busy || outbox.conflictBlocked || !!outbox.pending}
              onClick={() => void mutate("next-question")}>{t(view.generationState === "failed" ? "mathRetryGeneration" : "mathNextQuestion")}</button>}
        </section>
      )}
      {view.schemaVersion === 2 && !["completed", "cancelled"].includes(view.state) && (
        <button disabled={busy || outbox.conflictBlocked} onClick={() => void mutate("finish")}>{t("mathFinishTest")}</button>
      )}
      {view.state === "in_progress" && view.sitting?.state === "active" && (
        <button disabled={busy} onClick={() => void mutate("end-sitting")}>
          {t("mathEndSitting")}
        </button>
      )}
      {view.sitting?.state === "ended" && (
        <section className="math-card">
          <h2>{t("mathReview")}</h2>
          {review?.state === "idle" && (
            <button
              disabled={busy}
              onClick={() => void mutate("review", { action: "start" })}
            >
              {t("mathReview")}
            </button>
          )}
          {review?.state === "active" && (
            <>
              <p>
                {review.cursor + 1} / {review.attemptIds.length}
              </p>
              <button
                disabled={busy}
                onClick={() => void mutate("review", { action: "next" })}
              >
                {t("mathNext")}
              </button>
            </>
          )}
          {review?.state !== "active" && view.state === "in_progress" && (
            <button disabled={busy} onClick={() => void mutate("resume")}>
              {t("mathResume")}
            </button>
          )}
        </section>
      )}
      {(attempts.length > 0 || view.state === "completed") && (
        <section className="math-card">
          <h2>{t("mathResults")}</h2>
          <p>
            {view.score} / {view.maxScore} · {t("mathPendingGrades")}:{" "}
            {view.pendingGrades}
          </p>
          <p>
            {t("mathInvalidQuestions")}: {view.invalidCount ?? view.invalidQuestionIds.length}
          </p>
          {attempts.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                setSelected(a.id);
                setScores({});
              }}
            >
              {t("mathQuestion")}{" "}
              {a.questionOrdinal ?? a.ordinal ?? view.questions.find((q) => q.id === a.questionId)?.ordinal ?? a.sequence ?? a.questionId} ·{" "}
              {a.skipped
                ? t("mathSkipped")
                : t(
                    (
                      {
                        submitted: "mathGrading",
                        grading: "mathGrading",
                        graded: "mathGraded",
                        needs_review: "mathNeedsReview",
                        grading_failed: "mathGradingFailed",
                      } as const
                    )[a.assessmentState],
                  )}
              {a.assessment ? ` · ${a.assessment.correctnessScore}` : ""}
            </button>
          ))}
          {view.schemaVersion === 2 && <div>
            {historyPage && <button disabled={busy} onClick={() => setHistoryPage(undefined)}>{t("mathLatestAnswers")}</button>}
            {historyCursor && <button disabled={busy} onClick={() => setHistoryPage(historyCursor)}>{t("mathLoadMore")}</button>}
          </div>}
          <p className="math-muted">{t("mathEvidenceHint")}</p>
          <Link
            state={{ scopeRequest: view.config }}
            to={`/math/subjects/${view.config.subjectId}`}
          >
            {t("mathNewTestFromScope")}
          </Link>
        </section>
      )}
      {selectedAttempt && (
        <section className="math-card">
          <h2>{t("mathYourAnswer")}</h2>
          <MathMarkdown>
            {selectedAttempt.answerText ||
              t(selectedAttempt.skipped ? "mathSkipped" : "mathPaper")}
          </MathMarkdown>
          {selectedAttempt.assistanceUsed && <p>{t("mathAssisted")}</p>}
          {selectedAttempt.assessment && (
            <>
              <p>
                {t("mathGradeSource")}:{" "}
                {t(
                  (
                    {
                      ai: "mathAIProvisional",
                      deterministic: "mathDeterministic",
                      self: "mathSelf",
                      override: "mathOverride",
                    } as const
                  )[selectedAttempt.assessment.gradeSource],
                )}
              </p>
              <MathMarkdown>{selectedAttempt.assessment.feedback}</MathMarkdown>
              {selectedAttempt.assessment.criteria.map((c) => (
                <div key={c.criterionId}>
                  <p>
                    {c.awardedPoints} / {c.maxPoints}
                  </p>
                  {c.citationIds.map((id) => {
                    const citation =
                      selectedAttempt.assessment?.citations?.find(
                        (c) => c.citationId === id,
                      );
                    return citation ? (
                      <MathCitation
                        key={id}
                        citation={citation}
                        catalogId={view.catalogId}
                      />
                    ) : null;
                  })}
                  <MathMarkdown>{c.feedback}</MathMarkdown>
                </div>
              ))}
              {selectedAttempt.assessment.outsideMethodUsed && (
                <p>{t("mathOutsideMethod")}</p>
              )}
              <h3>{t("mathObjectives")}</h3>
              {selectedAttempt.assessment.objectiveEvidence.map((e) => (
                <p key={e.objectiveId}>
                  {e.objectiveId} ·{" "}
                  {e.demonstrated
                    ? t("mathDemonstrated")
                    : t("mathNotDemonstrated")}
                </p>
              ))}
            </>
          )}
          {selectedAttempt.assessmentState === "grading_failed" && (
            <button
              disabled={busy}
              onClick={() =>
                void mutate(
                  "retry-grade",
                  {},
                  { attemptId: selectedAttempt.id },
                )
              }
            >
              {t("mathRetryGrade")}
            </button>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void mutate("reveal", { questionId: selectedAttempt.questionId })
            }
          >
            {t("mathReveal")}
          </button>
          {currentSolution && (
            <>
              <MathSolutionView
                solution={currentSolution}
                catalogId={view.catalogId}
              />
              {!["submitted", "grading"].includes(
                selectedAttempt.assessmentState,
              ) && (
                <div>
                  <h2>{t("mathSelfGrade")}</h2>
                  {currentSolution.candidate.rubric.map((r) => (
                    <label key={r.criterionId}>
                      {r.description} (0–{r.points}){" "}
                      <input
                        type="number"
                        min={0}
                        max={r.points}
                        value={
                          scores[r.criterionId] ??
                          selectedAttempt.assessment?.criteria.find(
                            (c) => c.criterionId === r.criterionId,
                          )?.awardedPoints ??
                          0
                        }
                        onChange={(e) =>
                          setScores((s) => ({
                            ...s,
                            [r.criterionId]: Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                  ))}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        "assessment",
                        {
                          criterionScores: currentSolution.candidate.rubric.map(
                            (r) => ({
                              criterionId: r.criterionId,
                              points:
                                scores[r.criterionId] ??
                                selectedAttempt.assessment?.criteria.find(
                                  (c) => c.criterionId === r.criterionId,
                                )?.awardedPoints ??
                                0,
                            }),
                          ),
                          reason: t("mathSelfGrade"),
                        },
                        { attemptId: selectedAttempt.id },
                      )
                    }
                  >
                    {t("mathSaveGrade")}
                  </button>
                </div>
              )}
            </>
          )}
          <h2>{t("mathReport")}</h2>
          <label>
            {t("mathReason")}{" "}
            <select
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
            >
              <option value="incorrect-answer">
                {t("mathIncorrectAnswer")}
              </option>
              <option value="outside-scope">{t("mathOutsideScope")}</option>
              <option value="missing-conditions">
                {t("mathMissingConditions")}
              </option>
              <option value="other">{t("mathOther")}</option>
            </select>
          </label>
          <textarea
            value={report}
            onChange={(e) => setReport(e.target.value)}
            aria-label={t("mathReportDetails")}
          />
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void mathApi
                .report(
                  testId,
                  selectedAttempt.questionId,
                  reportReason,
                  report,
                )
                .then(() => setReport(""))
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            {t("mathSendReport")}
          </button>
          <button
            disabled={
              busy ||
              view.invalidQuestionIds.includes(selectedAttempt.questionId)
            }
            onClick={() => {
              if (window.confirm(t("mathInvalidateConfirm")))
                void mutate(
                  "invalidate",
                  { reason: report || t("mathIncorrectAnswer") },
                  { questionId: selectedAttempt.questionId },
                );
            }}
          >
            {t("mathInvalidate")}
          </button>
        </section>
      )}
    </>
  );
}
