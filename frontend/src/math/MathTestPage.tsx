import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, fetchJson, postJson } from "../api/client";
import { useI18n } from "../i18n/context";
import type {
  MathPublicTest,
  MathHistoryPage,
  MathBook,
  MathScopeInput,
  ObjectiveProgress,
} from "./types";
import { MathDialog, QuestionReview, useMathError } from "./ui";
import MathText from "./MathText";
import MathScopePicker from "./MathScopePicker";
type Action = "next" | "reveal" | "answer" | "scope" | "state";
export default function MathTestPage() {
  const { id } = useParams(),
    location = useLocation(),
    navigate = useNavigate(),
    { t } = useI18n(),
    describe = useMathError();
  const [test, setTest] = useState<MathPublicTest>(),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<"answer" | "scope" | "history">(),
    [books, setBooks] = useState<MathBook[]>([]),
    [selected, setSelected] = useState<MathScopeInput[]>([]),
    [scopeLoading, setScopeLoading] = useState(false),
    [scopeError, setScopeError] = useState("");
  const [history, setHistory] = useState<MathHistoryPage>(),
    [historyError, setHistoryError] = useState(""),
    [cursors, setCursors] = useState([0]),
    [records, setRecords] = useState<ObjectiveProgress[]>([]);
  const pending = useRef<
      { action: Action; body: string; id: string; version: number } | undefined
    >(undefined),
    inFlight = useRef(false),
    live = useRef(true),
    autoStart = useRef(false),
    card = useRef<HTMLElement>(null),
    menu = useRef<HTMLDetailsElement>(null);
  const current =
    test?.questions.find((q) => q.id === test.currentQuestionId) ??
    test?.questions[0];
  const feedback = !!current && test?.phase === "feedback",
    revealed =
      !!current &&
      (!!current.revealedAt || test?.phase === "solution" || feedback);
  const dirty =
    !!test && test.status !== "completed" && text !== (test.draft ?? "");
  const scopes =
    test?.scopes ??
    (test
      ? [
          {
            book: test.book,
            chapterIds: test.chapterIds,
            sourceVersionIds: test.sourceVersionIds,
          },
        ]
      : []);
  const install = useCallback((next: MathPublicTest) => {
    setTest(next);
    setText(
      next.status === "completed" || next.phase === "feedback"
        ? ""
        : next.draft,
    );
  }, []);
  async function load() {
    setLoading(true);
    setError("");
    try {
      const next = await fetchJson<MathPublicTest>(`/api/math/tests/${id}`);
      if (live.current) install(next);
    } catch (e) {
      if (live.current) setError(describe(e));
    } finally {
      if (live.current) setLoading(false);
    }
  }
  async function mutate(
    snapshot: MathPublicTest,
    action: Action,
    body: Record<string, unknown> = {},
    automatic = false,
  ): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const key = JSON.stringify(body);
    if (pending.current?.action !== action || pending.current.body !== key) {
      const answer =
        action === "answer"
          ? snapshot.answers[String(body.questionId)]
          : undefined;
      pending.current = {
        action,
        body: key,
        id: automatic
          ? `initial_${snapshot.id}`
          : answer && !answer.grade && answer.text === body.text
            ? answer.operationId
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
        pending.current = undefined;
        if (action === "next")
          requestAnimationFrame(() => {
            card.current?.scrollIntoView({
              block: "start",
              behavior: "smooth",
            });
            card.current?.focus({ preventScroll: true });
          });
      }
      return true;
    } catch (e) {
      if (live.current) {
        setError(describe(e));
        try {
          const next = await fetchJson<MathPublicTest>(
            `/api/math/tests/${snapshot.id}`,
          );
          const q = next.questions.find((q) => q.id === body.questionId);
          const scopeKey = (value: MathScopeInput[]) =>
            JSON.stringify(
              value
                .map((s) => ({
                  bookId: s.bookId,
                  chapterIds: [...s.chapterIds].sort(),
                }))
                .sort((a, b) => a.bookId.localeCompare(b.bookId)),
            );
          const conflict = e instanceof ApiError && e.status === 409;
          const draftMatches = body.draft === undefined || next.draft === body.draft;
          const succeeded = !conflict && (
            (action === "reveal" && draftMatches && !!q?.revealedAt) ||
            (action === "answer" &&
              !!next.answers[String(body.questionId)]?.grade) ||
            (action === "next" &&
              next.currentQuestionId !== snapshot.currentQuestionId) ||
            (action === "scope" && draftMatches &&
              (next.scopeRevision ?? 0) > (snapshot.scopeRevision ?? 0) &&
              scopeKey(
                (next.scopes ?? []).map((s) => ({
                  bookId: s.book.id,
                  chapterIds: s.chapterIds,
                })),
              ) === scopeKey(body.scopes as MathScopeInput[])) ||
            (action === "state" && draftMatches &&
              next.status ===
                (body.action === "pause"
                  ? "paused"
                  : body.action === "finish"
                    ? "completed"
                    : next.currentQuestionId
                      ? "active"
                      : "created")));
          if (live.current) {
            if (succeeded) {
              install(next);
              pending.current = undefined;
              setError("");
              return true;
            }
            if (!conflict) setTest(next);
          }
        } catch {
          /* Keep the failed request and the unsaved draft for retry. */
        }
      }
      return false;
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  }
  useEffect(() => {
    live.current = true;
    autoStart.current = false;
    pending.current = undefined;
    void load();
    return () => {
      live.current = false;
    };
  }, [id]);
  useEffect(() => {
    if (!test || autoStart.current || !location.state?.start) return;
    autoStart.current = true;
    navigate(location.pathname, { replace: true, state: null });
    if (test.phase === "ready" || test.status === "created")
      void mutate(test, "next", {}, true);
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
    if (dialog !== "history" || !test) return;
    const controller = new AbortController();
    setHistory(undefined);
    setHistoryError("");
    void Promise.all([
      fetchJson<MathHistoryPage>(
        `/api/math/tests/${test.id}/questions?after=${cursors.at(-1)}`,
        controller.signal,
      ),
      fetchJson<ObjectiveProgress[]>(
        `/api/math/tests/${test.id}/objectives`,
        controller.signal,
      ),
    ])
      .then(([h, r]) => {
        setHistory(h);
        setRecords(r);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setHistoryError(describe(e));
      });
    return () => controller.abort();
  }, [dialog, cursors, test?.version]);
  const act = (action: Action, body: Record<string, unknown> = {}) => {
    if (test) void mutate(test, action, body);
  };
  function openDialog(which: "answer" | "scope" | "history") {
    if (menu.current) menu.current.open = false;
    if (which === "history") setCursors([0]);
    if (which === "scope" && test) {
      setSelected(
        scopes.map((s) => ({ bookId: s.book.id, chapterIds: s.chapterIds })),
      );
      setScopeLoading(true);
      setScopeError("");
      void fetchJson<MathBook[]>("/api/math/books")
        .then((list) => {
          const all = new Map(list.map((b) => [b.id, b]));
          scopes.forEach((s) => all.set(s.book.id, s.book));
          setBooks([...all.values()]);
        })
        .catch((e) => setScopeError(describe(e)))
        .finally(() => setScopeLoading(false));
    }
    setDialog(which);
  }
  async function leave() {
    if (!test) return;
    if (test.status === "completed" || test.status === "paused") {
      navigate("/math");
      return;
    }
    if (await mutate(test, "state", { action: "pause", draft: text }))
      navigate("/math");
  }
  const finish = () => {
    if (window.confirm(t("mathFinishConfirm")))
      act("state", { action: "finish", draft: text });
    if (menu.current) menu.current.open = false;
  };
  return (
    <>
      <header className="math-test-heading">
        <Link
          className="math-back"
          to="/math"
          onClick={(e) => {
            e.preventDefault();
            if (!busy) void leave();
          }}
        >
          ← {t("mathLibrary")}
        </Link>
        <div>
          <div>
            <p className="math-eyebrow">{t("mathTitle")}</p>
            <h1>
              {scopes.map((s) => s.book.title).join(" · ") || t("mathTitle")}
            </h1>
          </div>
          {test && (
            <details ref={menu} className="math-test-menu">
              <summary aria-label={t("mathTestMenu")}>⋯</summary>
              <nav aria-label={t("mathTestMenu")}>
                {test.status !== "completed" && (
                  <>
                    <button disabled={busy} onClick={() => openDialog("scope")}>
                      {t("mathChangeScope")}
                    </button>
                    {current && (
                      <button
                        disabled={busy || test.status !== "active"}
                        onClick={() => openDialog("answer")}
                      >
                        {t("mathOptionalAnswer")}
                        {dirty || test.draft
                          ? ` · ${t("mathDraftAvailable")}`
                          : ""}
                      </button>
                    )}
                  </>
                )}
                <button disabled={busy} onClick={() => openDialog("history")}>
                  {t("mathAnswerHistory")}
                </button>
                {test.status !== "completed" && (
                  <>
                    <button disabled={busy} onClick={() => void leave()}>
                      {t("mathPause")}
                    </button>
                    <button disabled={busy} onClick={finish}>
                      {t("mathFinish")}
                    </button>
                  </>
                )}
              </nav>
            </details>
          )}
        </div>
      </header>
      {loading && (
        <p role="status" className="math-loading">
          {t("mathLoading")}
        </p>
      )}
      {error && !dialog && (
        <div role="alert" className="math-error">
          <p>{error}</p>
          <button
            className="math-button-secondary"
            disabled={busy}
            onClick={() => {
              if (!dirty || window.confirm(t("mathLeaveWarning"))) {
                pending.current = undefined;
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
          <p className="math-help">
            {t("mathRevealedCount")}: {test.stats?.revealed ?? 0} ·{" "}
            {t("mathQuestion")}: {test.generatedCount ?? 0}
          </p>
          {test.status === "completed" ? (
            <section className="math-panel math-completion">
              <h2>{t("mathSessionComplete")}</h2>
              <p>
                {t("mathRevealedCount")}: {test.stats?.revealed ?? 0} ·{" "}
                {t("mathAnsweredCount")}: {test.stats?.answered ?? 0}
              </p>
              <button
                className="math-button-primary"
                onClick={() => openDialog("history")}
              >
                {t("mathReviewAnswers")}
              </button>
            </section>
          ) : test.status === "paused" ? (
            <section className="math-panel math-paused">
              <h2>{t("mathPausedHeading")}</h2>
              <p>{t("mathPausedHelp")}</p>
              <button
                disabled={busy}
                className="math-button-primary"
                onClick={() =>
                  act("state", { action: "resume", draft: test.draft })
                }
              >
                {t("mathResume")}
              </button>
            </section>
          ) : (
            <>
              <section
                ref={card}
                tabIndex={-1}
                className="math-panel math-question-card"
              >
                {current ? (
                  <>
                    <div className="math-tags">
                      <span>
                        {t("mathQuestion")}{" "}
                        {current.number ?? test.generatedCount}
                      </span>
                      <span>{current.bookTitle ?? test.book.title}</span>
                      <span>
                        {t(`math_${current.taskKind ?? current.kind}`)}
                      </span>
                    </div>
                    {feedback ? (
                      <QuestionReview
                        item={{
                          question: current,
                          answer: test.answers[current.id],
                          number: current.number ?? test.generatedCount ?? 1,
                        }}
                        book={test.book}
                      />
                    ) : (
                      <>
                        <MathText text={current.prompt} />
                        {revealed && current.solution && (
                          <section className="math-revealed-solution">
                            <h2>{t("mathSolution")}</h2>
                            <MathText text={current.solution} />
                          </section>
                        )}
                      </>
                    )}
                    <details className="math-settings">
                      <summary>{t("mathQuestionDetails")}</summary>
                      <p>
                        {t("mathDifficulty")}:{" "}
                        {t(`math_${current.difficulty ?? test.difficulty}`)}
                      </p>
                      {current.objectiveStatement && (
                        <MathText
                          text={`${t("mathObjective")}: ${current.objectiveStatement}`}
                        />
                      )}
                      <MathText
                        text={`${t("mathSource")}: ${current.heading}`}
                      />
                    </details>
                  </>
                ) : (
                  <>
                    <h2>{t("mathPreparingFirst")}</h2>
                    <p>{t("mathFirstHelp")}</p>
                  </>
                )}
              </section>
              <div className="math-action-bar math-review-action">
                <button
                  className="math-button-primary"
                  disabled={busy}
                  onClick={() =>
                    current && !revealed
                      ? act("reveal", { questionId: current.id, draft: text })
                      : act("next", { draft: text })
                  }
                >
                  {busy
                    ? t("mathWorking")
                    : current
                      ? revealed
                        ? t("mathNextQuestion")
                        : t("mathRevealAnswer")
                      : t("mathGenerate")}
                  {current && revealed ? " →" : ""}
                </button>
              </div>
            </>
          )}
          <p className="math-ai-note">{t("mathAiNotice")}</p>
        </>
      )}
      {dialog === "answer" && test && current && (
        <MathDialog
          title={t("mathOptionalAnswer")}
          onClose={() => setDialog(undefined)}
        >
          {error && <p role="alert" className="math-error">{error}</p>}
          <MathText text={current.prompt} />
          <label className="math-label">
            {t("mathYourAnswer")}
            <textarea
              className="math-field math-answer-input"
              aria-label={t("mathYourAnswer")}
              maxLength={5000}
              disabled={busy || !!test.answers[current.id]?.grade}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <p className="math-help">{t("mathDraftHelp")}</p>
          <button
            className="math-button-primary"
            disabled={busy || !text.trim() || !!test.answers[current.id]?.grade}
            onClick={() =>
              void mutate(test, "answer", {
                questionId: current.id,
                text,
              }).then((ok) => {
                if (ok) setDialog(undefined);
              })
            }
          >
            {t("mathSubmitAnswer")}
          </button>
        </MathDialog>
      )}
      {dialog === "scope" && test && (
        <MathDialog
          title={t("mathChangeScope")}
          onClose={() => {
            if (!busy) setDialog(undefined);
          }}
        >
          <p className="math-help">{t("mathScopeNextHelp")}</p>
          {error && <p role="alert" className="math-error">{error}</p>}
          {scopeError && (
            <p role="alert" className="math-error">
              {scopeError}
            </p>
          )}
          {scopeLoading ? (
            <p role="status">{t("mathLoading")}</p>
          ) : (
            <MathScopePicker
              books={books}
              value={selected}
              onChange={setSelected}
              disabled={busy}
            />
          )}
          <button
            className="math-button-primary"
            disabled={
              busy ||
              scopeLoading ||
              !selected.length ||
              selected.reduce((n, s) => n + s.chapterIds.length, 0) > 100
            }
            onClick={() =>
              void mutate(test, "scope", {
                scopes: selected,
                draft: text,
              }).then((ok) => {
                if (ok) setDialog(undefined);
              })
            }
          >
            {t("mathApplyScope")}
          </button>
        </MathDialog>
      )}
      {dialog === "history" && test && (
        <MathDialog
          title={t("mathAnswerHistory")}
          onClose={() => setDialog(undefined)}
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
                  <details className="math-review-item" key={item.question.id}>
                    <summary>
                      {t("mathQuestion")} {item.number} ·{" "}
                      {item.question.bookTitle ?? test.book.title} ·{" "}
                      {item.answer?.grade
                        ? t(`math_${item.answer.grade.verdict}`)
                        : item.question.revealedAt
                          ? t("mathAnswerRevealed")
                          : t("mathUnsubmitted")}
                    </summary>
                    <QuestionReview item={item} book={test.book} />
                  </details>
                ))}
              </div>
              {!history.items.length && <p>{t("mathNoAnswersYet")}</p>}
              <div className="math-pagination">
                <button
                  className="math-button-secondary"
                  disabled={cursors.length === 1}
                  onClick={() => setCursors((c) => c.slice(0, -1))}
                >
                  {t("mathPreviousPage")}
                </button>
                <span>{cursors.length}</span>
                <button
                  className="math-button-secondary"
                  disabled={history.nextCursor === null}
                  onClick={() => setCursors((c) => [...c, history.nextCursor!])}
                >
                  {t("mathNextPage")}
                </button>
              </div>
              <details className="math-settings">
                <summary>{t("mathObjectiveRecords")}</summary>
                <p className="math-help">{t("mathSharedEvidence")}</p>
                {records.map((row) => (
                  <p key={`${row.bookId}:${row.objectiveId}`}>
                    {row.bookId} / {row.objectiveId}: {t("mathRevealedCount")}{" "}
                    {row.revealed ?? 0} · {t("mathAnsweredCount")}{" "}
                    {row.submitted}
                  </p>
                ))}
              </details>
            </>
          )}
        </MathDialog>
      )}
    </>
  );
}
