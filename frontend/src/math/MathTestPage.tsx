import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { fetchJson, postJson } from "../api/client";
import { useI18n } from "../i18n/context";
import type { MathPublicTest, MathHistoryPage } from "./types";
import { MathDialog, QuestionReview, useMathError } from "./ui";
import MathText from "./MathText";
type Action = "generate" | "next" | "answer" | "state";
export default function MathTestPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const describe = useMathError();
  const [test, setTest] = useState<MathPublicTest>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<Action>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<MathHistoryPage>();
  const [historyError, setHistoryError] = useState("");
  const [cursors, setCursors] = useState([0]);
  const pending = useRef<{
    action: Action;
    body: string;
    id: string;
    version: number;
  } | null>(null);
  const live = useRef(true);
  const autoStart = useRef(false);
  const inFlight = useRef(false);
  const card = useRef<HTMLElement>(null);
  const current =
    test?.phase === "feedback"
      ? test.questions.find((q) => q.id === test.currentQuestionId)
      : test?.questions.find(
          (q) =>
            !test.answers[q.id]?.grade &&
            test.answers[q.id]?.submitted !== false,
        );
  const feedback = !!current && test?.phase === "feedback";
  const saved = current && !feedback ? (test?.draft ?? "") : "";
  const dirty = text !== saved;
  const continuous = test?.mode === "continuous";
  const stats =
    test?.stats ??
    Object.values(test?.answers ?? {}).reduce(
      (acc, a) => {
        if (a.grade) {
          acc.answered++;
          acc[a.grade.verdict]++;
        }
        return acc;
      },
      { answered: 0, correct: 0, partial: 0, incorrect: 0 },
    );
  const generated = continuous
    ? (test?.generatedCount ?? 0)
    : (test?.questions.length ?? 0);
  const install = useCallback((next: MathPublicTest) => {
    setTest(next);
    setText(
      next.status === "completed" || next.phase === "feedback"
        ? ""
        : next.draft,
    );
  }, []);
  async function mutate(
    snapshot: MathPublicTest,
    action: Action,
    body: Record<string, unknown>,
    automatic = false,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProcessing(action);
    setError("");
    const key = JSON.stringify(body);
    if (pending.current?.action !== action || pending.current.body !== key) {
      const a =
        action === "answer"
          ? snapshot.answers[String(body.questionId)]
          : undefined;
      pending.current = {
        action,
        body: key,
        id: automatic
          ? `initial_${snapshot.id}`
          : a && !a.grade && a.text === body.text
            ? a.operationId
            : crypto.randomUUID(),
        version: snapshot.version,
      };
    }
    try {
      const next = await postJson<MathPublicTest>(
        `/api/math/tests/${snapshot.id}/${action}`,
        {
          ...body,
          operationId: pending.current.id,
          version: pending.current.version,
        },
      );
      if (live.current) {
        install(next);
        pending.current = null;
        if (action === "next" || action === "answer" || action === "generate")
          requestAnimationFrame(() => {
            card.current?.scrollIntoView({
              block: "start",
              behavior: "smooth",
            });
            card.current?.focus({ preventScroll: true });
          });
      }
    } catch (err) {
      if (live.current) {
        setError(describe(err));
        try {
          const next = await fetchJson<MathPublicTest>(
            `/api/math/tests/${snapshot.id}`,
          );
          if (live.current) {
            if (
              (action === "answer" &&
                next.answers[String(body.questionId)]?.grade) ||
              (action === "next" &&
                (next.currentQuestionId !== snapshot.currentQuestionId ||
                  next.status === "completed")) ||
              (action === "generate" && next.status === "active")
            ) {
              install(next);
              pending.current = null;
              setError("");
            } else setTest(next);
          }
        } catch {
          /* Keep the original error and unsaved input. */
        }
      }
    } finally {
      inFlight.current = false;
      if (live.current) {
        setBusy(false);
        setProcessing(undefined);
      }
    }
  }
  async function load() {
    setLoading(true);
    setError("");
    try {
      const next = await fetchJson<MathPublicTest>(`/api/math/tests/${id}`);
      if (live.current) install(next);
    } catch (err) {
      if (live.current) setError(describe(err));
    } finally {
      if (live.current) setLoading(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [id]);
  useEffect(() => {
    if (!test || autoStart.current || !location.state?.start) return;
    autoStart.current = true;
    navigate(location.pathname, { replace: true, state: null });
    if (
      (test.mode === "continuous" && test.phase === "ready") ||
      test.status === "created"
    )
      void mutate(
        test,
        test.mode === "continuous" ? "next" : "generate",
        {},
        true,
      );
  }, [test, location.state]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty || busy) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, busy]);
  useEffect(() => {
    if (!historyOpen || !test) return;
    const controller = new AbortController();
    setHistory(undefined);
    setHistoryError("");
    void fetchJson<MathHistoryPage>(
      `/api/math/tests/${test.id}/questions?after=${cursors[cursors.length - 1]}`,
      controller.signal,
    )
      .then(setHistory)
      .catch((err) => {
        if (!controller.signal.aborted) setHistoryError(describe(err));
      });
    return () => controller.abort();
  }, [historyOpen, cursors, test?.version]);
  const act = (action: Action, body: Record<string, unknown> = {}) => {
    if (test) void mutate(test, action, body);
  };
  const finish = () => {
    if (window.confirm(t("mathFinishConfirm")))
      act("state", { action: "finish", draft: text });
  };
  const openHistory = () => {
    setCursors([0]);
    setHistoryOpen(true);
  };
  return (
    <>
      <header className="math-test-heading">
        <Link
          className="math-back"
          to="/math"
          onClick={(e) => {
            if ((dirty || busy) && !window.confirm(t("mathLeaveWarning")))
              e.preventDefault();
          }}
        >
          ← {t("mathLibrary")}
        </Link>
        <div>
          <div>
            <p className="math-eyebrow">{t("mathTitle")}</p>
            <h1>{test?.book.title ?? t("mathTitle")}</h1>
          </div>
          {test && (
            <span
              className={`math-status ${test.status === "completed" ? "is-completed" : ""}`}
            >
              {t(`math_status_${test.status}`)}
            </span>
          )}
        </div>
      </header>
      {loading && (
        <p role="status" className="math-loading">
          {t("mathLoading")}
        </p>
      )}
      {error && (
        <div role="alert" className="math-error">
          <p>{error}</p>
          <button
            className="math-button-secondary"
            disabled={busy}
            onClick={() => {
              if (!dirty || window.confirm(t("mathLeaveWarning"))) {
                pending.current = null;
                void load();
              }
            }}
          >
            {t("mathReload")}
          </button>
        </div>
      )}
      {test && (
        <>
          <div className="math-progress-row">
            <p>
              <strong>{stats.answered}</strong> {t("mathAnsweredCount")}
              {!continuous && ` / ${test.count}`}
            </p>
            <button className="math-button-quiet" onClick={openHistory}>
              {t("mathAnswerHistory")} ↗
            </button>
          </div>
          {test.status === "completed" ? (
            <section className="math-panel math-completion">
              <span className="math-completion-icon" aria-hidden>
                ✓
              </span>
              <p className="math-eyebrow">{t("mathSessionComplete")}</p>
              <h2>{t("mathWellStudied")}</h2>
              <div className="math-result-grid">
                {(["correct", "partial", "incorrect"] as const).map((v) => (
                  <div key={v} className={`math-verdict-${v}`}>
                    <strong>{stats[v]}</strong>
                    <span>{t(`math_${v}`)}</span>
                  </div>
                ))}
                <div>
                  <strong>{generated - stats.answered}</strong>
                  <span>{t("mathUnanswered")}</span>
                </div>
              </div>
              <div className="math-completion-actions">
                <button className="math-button-primary" onClick={openHistory}>
                  {t("mathReviewAnswers")}
                </button>
                <Link className="math-button-secondary" to="/math">
                  {t("mathLibrary")}
                </Link>
              </div>
            </section>
          ) : test.status === "paused" ? (
            <section className="math-panel math-paused">
              <p className="math-eyebrow">{t("mathSaved")}</p>
              <h2>{t("mathPausedHeading")}</h2>
              <p className="math-help">{t("mathPausedHelp")}</p>
              <button
                className="math-button-primary"
                disabled={busy}
                onClick={() =>
                  act("state", { action: "resume", draft: test.draft })
                }
              >
                {t("mathResume")} →
              </button>
            </section>
          ) : (
            <>
              {current ? (
                <section
                  ref={card}
                  tabIndex={-1}
                  className="math-panel math-question-card"
                >
                  <div className="math-tags">
                    <span className="math-question-number">
                      {t("mathQuestion")}{" "}
                      {current.number ?? test.questions.indexOf(current) + 1}
                    </span>
                    <span>{t(`math_${current.kind}`)}</span>
                    <span>
                      {
                        test.book.chapters.find(
                          (c) => c.id === current.chapterId,
                        )?.title
                      }
                    </span>
                  </div>
                  {feedback ? (
                    <QuestionReview
                      item={{
                        question: current,
                        answer: test.answers[current.id],
                        number:
                          current.number ?? test.questions.indexOf(current) + 1,
                      }}
                      book={test.book}
                    />
                  ) : (
                    <>
                      <div className="math-question-prompt">
                        <MathText text={current.prompt} />
                      </div>
                      <label className="math-label math-answer-label">
                        {t("mathYourAnswer")}
                        <textarea
                          aria-label={t("mathYourAnswer")}
                          className="math-field math-answer-input"
                          maxLength={5000}
                          value={text}
                          disabled={busy}
                          placeholder={t("mathAnswerPlaceholder")}
                          onChange={(e) => setText(e.target.value)}
                        />
                      </label>
                      <p className="math-help">{t("mathDraftHelp")}</p>
                      {current.solution && (
                        <details className="math-example-solution">
                          <summary>{t("mathSolution")}</summary>
                          <MathText text={current.solution} />
                          <p className="math-source">
                            {t("mathSource")}: {current.heading}
                          </p>
                        </details>
                      )}
                    </>
                  )}
                </section>
              ) : (
                <section
                  ref={card}
                  tabIndex={-1}
                  className="math-panel math-empty"
                >
                  <h2>{t("mathPreparingFirst")}</h2>
                  <p>{t("mathFirstHelp")}</p>
                </section>
              )}
              <div className="math-action-bar">
                <div className="math-primary-action">
                  {feedback ? (
                    <button
                      className="math-button-primary"
                      disabled={busy}
                      onClick={() => act("next", { draft: text })}
                    >
                      {t("mathNextQuestion")} →
                    </button>
                  ) : current ? (
                    <>
                      <button
                        className="math-button-secondary"
                        disabled={busy}
                        onClick={() => act("next", { draft: text })}
                      >
                        {t("mathSkipQuestion")} →
                      </button>
                      <button
                        className="math-button-primary"
                        disabled={busy || !text.trim()}
                        onClick={() =>
                          act("answer", { questionId: current.id, text })
                        }
                      >
                        {t("mathSubmitAnswer")}
                      </button>
                    </>
                  ) : (
                    <button
                      className="math-button-primary"
                      disabled={busy}
                      onClick={() => act(continuous ? "next" : "generate")}
                    >
                      {error ? t("mathRetry") : t("mathGenerate")}
                    </button>
                  )}
                </div>
                <div className="math-secondary-actions">
                  {!["created", "generating", "generation_failed"].includes(
                    test.status,
                  ) && (
                    <>
                      <button
                        className="math-button-secondary"
                        disabled={busy}
                        onClick={() =>
                          act("state", { action: "pause", draft: text })
                        }
                      >
                        {t("mathPause")}
                      </button>
                      <button
                        className="math-button-quiet"
                        disabled={busy}
                        onClick={finish}
                      >
                        {t("mathFinish")}
                      </button>
                    </>
                  )}
                </div>
                {busy && (
                  <p role="status" className="math-processing">
                    <span className="math-spinner" />
                    {t(
                      processing === "answer"
                        ? "mathGrading"
                        : processing === "state"
                          ? "mathWorking"
                          : "mathGenerating",
                    )}
                  </p>
                )}
              </div>
            </>
          )}
          {test.status === "paused" && (
            <div className="math-paused-end">
              <button
                className="math-button-quiet"
                disabled={busy}
                onClick={finish}
              >
                {t("mathFinish")}
              </button>
            </div>
          )}
          <p className="math-ai-note">{t("mathAiNotice")}</p>
        </>
      )}
      {historyOpen && test && (
        <MathDialog
          title={
            test.status === "completed"
              ? t("mathReviewAnswers")
              : t("mathAnswerHistory")
          }
          onClose={() => setHistoryOpen(false)}
        >
          {historyError ? (
            <p role="alert" className="math-error">
              {historyError}
            </p>
          ) : !history ? (
            <p role="status">{t("mathLoading")}</p>
          ) : (
            <>
              <div className="math-review-list">
                {history.items.map((item) => (
                  <details key={item.question.id} className="math-review-item">
                    <summary>
                      <span>
                        {t("mathQuestion")} {item.number} ·{" "}
                        {t(`math_${item.question.kind}`)}
                      </span>
                      <span
                        className={
                          item.answer?.grade
                            ? `math-verdict-${item.answer.grade.verdict}`
                            : ""
                        }
                      >
                        {item.answer?.grade
                          ? t(`math_${item.answer.grade.verdict}`)
                          : t("mathUnanswered")}
                      </span>
                    </summary>
                    <QuestionReview item={item} book={test.book} />
                  </details>
                ))}
                {!history.items.length && <p>{t("mathNoAnswersYet")}</p>}
              </div>
              <div className="math-pagination">
                <button
                  className="math-button-secondary"
                  disabled={cursors.length === 1}
                  onClick={() =>
                    setCursors((previous) => previous.slice(0, -1))
                  }
                >
                  {t("mathPreviousPage")}
                </button>
                <span>{cursors.length}</span>
                <button
                  className="math-button-secondary"
                  disabled={history.nextCursor === null}
                  onClick={() =>
                    setCursors((previous) => [...previous, history.nextCursor!])
                  }
                >
                  {t("mathNextPage")}
                </button>
              </div>
            </>
          )}
        </MathDialog>
      )}
    </>
  );
}
