import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useNavigate,
  useParams,
  useLocation,
} from "react-router-dom";
import { useI18n } from "../i18n/context";
import { ApiError, fetchJson, postJson } from "../api/client";
import type { TranslationKey } from "../i18n/translations";
import type {
  MathBook,
  MathSource,
  MathPublicTest,
  MathKind,
  MathDifficulty,
} from "./types";
import MathText from "./MathText";
const base = "/api/math";
const button = "rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-40";
const field = "rounded border border-gray-600 bg-gray-900 p-2";
function useMathError() {
  const { t } = useI18n();
  return (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 404) return t("mathNotFound");
      if (err.message.includes("MATH_SCOPE_TOO_LARGE"))
        return t("mathScopeLarge");
      if (err.message.includes("MATH_BUSY")) return t("mathBusy");
      if (err.status === 409) return t("mathConflict");
    }
    return t("mathFailure");
  };
}
type History = {
  id: string;
  title: string;
  status: MathPublicTest["status"];
  createdAt: string;
  count: number;
};
function Library() {
  const { t } = useI18n();
  const describe = useMathError();
  const navigate = useNavigate();
  const [books, setBooks] = useState<MathBook[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [bookId, setBookId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState<MathDifficulty>("standard");
  const [kinds, setKinds] = useState<MathKind[]>([
    "definition",
    "calculation",
    "proof",
  ]);
  const [preview, setPreview] = useState<MathSource>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const createOperation = useRef<{ body: string; id: string } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [b, h] = await Promise.all([
        fetchJson<MathBook[]>(`${base}/books`),
        fetchJson<History[]>(`${base}/tests`),
      ]);
      setBooks(b);
      setHistory(h);
    } catch (err) {
      setError(describe(err));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);
  const book = books.find((b) => b.id === bookId);
  async function start() {
    if (!book) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        bookId: book.id,
        chapterIds: selected,
        count,
        difficulty,
        kinds,
      };
      const key = JSON.stringify(body);
      if (createOperation.current?.body !== key)
        createOperation.current = { body: key, id: crypto.randomUUID() };
      const test = await postJson<MathPublicTest>(`${base}/tests`, {
        ...body,
        operationId: createOperation.current.id,
      });
      navigate(`/math/tests/${test.id}`);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="text-blue-300" to="/">
        ← {t("mathCategories")}
      </Link>
      {loading && <p role="status">{t("mathLoading")}</p>}
      {error && (
        <p role="alert" className="text-red-300">
          {error} <button onClick={() => void load()}>{t("mathReload")}</button>
        </p>
      )}
      {!loading && !error && !books.length && <p>{t("mathNoBooks")}</p>}
      <div className="space-y-4">
        <label className="block">
          {t("mathBook")}{" "}
          <select
            className={field}
            value={bookId}
            disabled={busy}
            onChange={(e) => {
              setBookId(e.target.value);
              setSelected([]);
              setPreview(undefined);
            }}
          >
            <option value="">{t("mathSelectBook")}</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.subjectTitle} / {b.title}
              </option>
            ))}
          </select>
        </label>
        {book && (
          <>
            <p className="text-sm text-gray-400">
              {t("mathScopeHelp")} · {book.language}
            </p>
            <fieldset disabled={busy} className="space-y-3">
              <legend>{t("mathChapters")}</legend>
              {book.chapters.map((c) => (
                <div key={c.id} className="flex items-center gap-3">
                  <label className="flex-1">
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, c.id]
                            : selected.filter((id) => id !== c.id),
                        )
                      }
                    />{" "}
                    {c.number}. {c.title}
                  </label>
                  <button
                    className="text-blue-300"
                    onClick={async () => {
                      setError("");
                      try {
                        setPreview(
                          await fetchJson<MathSource>(
                            `${base}/chapters/${c.versionId}`,
                          ),
                        );
                      } catch (err) {
                        setError(describe(err));
                      }
                    }}
                  >
                    {t("mathPreview")}
                  </button>
                </div>
              ))}
            </fieldset>
            {preview && (
              <details open className="rounded border border-gray-700 p-4">
                <summary>
                  {preview.number}. {preview.title}
                </summary>
                <MathText text={preview.markdown} />
              </details>
            )}
            <label className="block">
              {t("mathCount")}{" "}
              <input
                className={`${field} w-20`}
                type="number"
                min={1}
                max={10}
                value={count}
                disabled={busy}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
            <label className="block">
              {t("mathDifficulty")}{" "}
              <select
                className={field}
                value={difficulty}
                disabled={busy}
                onChange={(e) =>
                  setDifficulty(e.target.value as MathDifficulty)
                }
              >
                {(["easy", "standard", "hard"] as const).map((d) => (
                  <option key={d} value={d}>
                    {t(`math_${d}`)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset disabled={busy} className="flex flex-wrap gap-4">
              <legend>{t("mathKinds")}</legend>
              {(["definition", "calculation", "proof"] as const).map((k) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={kinds.includes(k)}
                    onChange={(e) =>
                      setKinds(
                        e.target.checked
                          ? [...kinds, k]
                          : kinds.filter((x) => x !== k),
                      )
                    }
                  />{" "}
                  {t(`math_${k}`)}
                </label>
              ))}
            </fieldset>
            <button
              className={button}
              disabled={
                busy ||
                !selected.length ||
                !kinds.length ||
                !Number.isInteger(count) ||
                count < 1 ||
                count > 10
              }
              onClick={() => void start()}
            >
              {busy ? t("mathWorking") : t("mathStart")}
            </button>
          </>
        )}
      </div>
      <h2 className="mt-8 text-xl font-semibold">{t("mathHistory")}</h2>
      <ul className="space-y-3">
        {history.map((h) => (
          <li key={h.id}>
            <Link
              className="text-blue-300 underline"
              to={`/math/tests/${h.id}`}
            >
              {h.title} · {new Date(h.createdAt).toLocaleString()} ·{" "}
              {t(`math_status_${h.status}` as TranslationKey)}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
function Test() {
  const { id } = useParams();
  const { t } = useI18n();
  const describe = useMathError();
  const [test, setTest] = useState<MathPublicTest>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const pending = useRef<{
    action: string;
    body: string;
    id: string;
    version: number;
  } | null>(null);
  const current = test?.questions.find((q) => !test.answers[q.id]?.grade);
  const saved = current ? (test?.draft ?? "") : "";
  const dirty = text !== saved;
  const install = useCallback((next: MathPublicTest) => {
    setTest(next);
    const q = next.questions.find((q) => !next.answers[q.id]?.grade);
    setText(q ? next.draft : "");
  }, []);
  async function load() {
    setLoading(true);
    setError("");
    try {
      install(await fetchJson<MathPublicTest>(`${base}/tests/${id}`));
    } catch (err) {
      setError(describe(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
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
  async function mutate(
    action: "generate" | "answer" | "state",
    body: Record<string, unknown>,
  ) {
    if (!test) return;
    setBusy(true);
    setError("");
    const key = JSON.stringify(body);
    if (pending.current?.action !== action || pending.current?.body !== key) {
      const answer = current && test.answers[current.id];
      pending.current = {
        action,
        body: key,
        id:
          action === "answer" && answer && !answer.grade && answer.text === text
            ? answer.operationId
            : crypto.randomUUID(),
        version: test.version,
      };
    }
    try {
      const next = await postJson<MathPublicTest>(
        `${base}/tests/${test.id}/${action}`,
        {
          ...body,
          operationId: pending.current.id,
          version: pending.current.version,
        },
      );
      install(next);
      pending.current = null;
    } catch (err) {
      setError(describe(err));
      try {
        const next = await fetchJson<MathPublicTest>(
          `${base}/tests/${test.id}`,
        );
        if (
          action === "answer" &&
          next.answers[String(body.questionId)]?.grade
        ) {
          install(next);
          pending.current = null;
        } else setTest(next);
      } catch {
        /* Preserve original failure and unsaved answer. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <Link
        className="text-blue-300 underline"
        to="/math"
        onClick={(e) => {
          if ((dirty || busy) && !window.confirm(t("mathLeaveWarning")))
            e.preventDefault();
        }}
      >
        {t("mathLibrary")}
      </Link>
      {loading && <p role="status">{t("mathLoading")}</p>}
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      <button
        className="text-blue-300"
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
      {test && (
        <>
          <h2 className="text-xl">
            {test.book.title} · {t(`math_status_${test.status}`)}
          </h2>
          <p>
            {test.questions.filter((q) => test.answers[q.id]?.grade).length} /{" "}
            {test.count}
          </p>
          <p className="text-sm text-gray-400">{t("mathAiNotice")}</p>
          {busy && <p role="status">{t("mathWorking")}</p>}
          {["created", "generating", "generation_failed"].includes(
            test.status,
          ) && (
            <button
              className={button}
              disabled={busy}
              onClick={() => void mutate("generate", {})}
            >
              {t("mathGenerate")}
            </button>
          )}
          {test.status === "paused" && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void mutate("state", { action: "resume", draft: test.draft })
              }
            >
              {t("mathResume")}
            </button>
          )}
          {test.questions
            .filter(
              (q) => test.answers[q.id]?.grade || test.status === "completed",
            )
            .map((q) => (
              <details
                key={q.id}
                open
                className="space-y-3 rounded border border-gray-700 p-4"
              >
                <summary>
                  {q.id} · {t(`math_${q.kind}`)} ·{" "}
                  {test.book.chapters.find((c) => c.id === q.chapterId)?.title}
                </summary>
                <MathText text={q.prompt} />
                <p className="font-semibold">{t("mathYourAnswer")}</p>
                <MathText
                  text={test.answers[q.id]?.text || t("mathUnanswered")}
                />
                {test.answers[q.id]?.grade && (
                  <>
                    <p>{t(`math_${test.answers[q.id].grade!.verdict}`)}</p>
                    <MathText text={test.answers[q.id].grade!.feedback} />
                  </>
                )}
                <p className="font-semibold">{t("mathSolution")}</p>
                <MathText text={q.solution ?? ""} />
                <p className="text-sm text-gray-400">
                  {t("mathSource")}: {q.heading}
                </p>
              </details>
            ))}
          {test.status === "active" && current && (
            <section className="space-y-4 rounded border border-gray-600 p-4">
              <p>
                {current.id} · {t(`math_${current.kind}`)}
              </p>
              <MathText text={current.prompt} />
              <label className="block">
                {t("mathYourAnswer")}
                <textarea
                  aria-label={t("mathYourAnswer")}
                  className={`${field} mt-2 block min-h-48 w-full`}
                  maxLength={5000}
                  value={text}
                  disabled={busy}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <p className="text-sm text-gray-400">{t("mathDraftHelp")}</p>
              <div className="flex flex-wrap gap-3">
                <button
                  className={button}
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    void mutate("answer", { questionId: current.id, text })
                  }
                >
                  {t("mathSubmit")}
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void mutate("state", { action: "pause", draft: text })
                  }
                >
                  {t("mathPause")}
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t("mathFinishConfirm")))
                      void mutate("state", { action: "finish", draft: text });
                  }}
                >
                  {t("mathFinish")}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
export default function MathRoutes() {
  const { t } = useI18n();
  const location = useLocation();
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6 text-gray-100">
      <h1 className="text-2xl font-semibold">{t("mathTitle")}</h1>
      <Routes>
        <Route index element={<Library />} />
        <Route path="tests/:id" element={<Test key={location.pathname} />} />
        <Route
          path="*"
          element={
            <p role="status">
              {t("mathNotFound")} <Link to="/math">{t("mathLibrary")}</Link>
            </p>
          }
        />
      </Routes>
    </main>
  );
}
