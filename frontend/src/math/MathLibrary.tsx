import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchJson, postJson } from "../api/client";
import { useI18n } from "../i18n/context";
import type {
  MathBook,
  MathDifficulty,
  TaskKind,
  MathPublicTest,
  MathSource,
} from "./types";
import { MathDialog, useMathError } from "./ui";
import MathText from "./MathText";
type SavedTest = {
  id: string;
  title: string;
  status: MathPublicTest["status"];
  createdAt: string;
  mode?: string;
  answered?: number;
  count: number;
};
export default function MathLibrary() {
  const { t, language } = useI18n();
  const describe = useMathError();
  const navigate = useNavigate();
  const [books, setBooks] = useState<MathBook[]>([]);
  const [history, setHistory] = useState<SavedTest[]>([]);
  const [bookId, setBookId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<MathDifficulty>("standard");
  const [kinds, setKinds] = useState<TaskKind[]>([
    "prove",
    "determine",
    "compute",
    "derive",
  ]);
  const [preview, setPreview] = useState<{
    title: string;
    source?: MathSource;
    error?: string;
  }>();
  const previewRequest = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const createOperation = useRef<{ body: string; id: string } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [b, h] = await Promise.all([
        fetchJson<MathBook[]>("/api/math/books"),
        fetchJson<SavedTest[]>("/api/math/tests"),
      ]);
      setBooks(b);
      setHistory(h);
      setBookId((previous) =>
        b.some((book) => book.id === previous)
          ? previous
          : b.length === 1
            ? b[0].id
            : "",
      );
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
  const latest = history.find((h) => h.status !== "completed");
  async function start() {
    if (!book) return;
    setBusy(true);
    setError("");
    try {
      const body = {
        mode: "continuous",
        bookId: book.id,
        chapterIds: selected,
        difficulty,
        ...(book.publicationId
          ? { assessmentVersion: 2, taskKinds: kinds }
          : {
              kinds: [
                ...new Set(
                  kinds.map((k) =>
                    k === "prove"
                      ? "proof"
                      : k === "determine"
                        ? "definition"
                        : "calculation",
                  ),
                ),
              ],
            }),
      };
      const key = JSON.stringify(body);
      if (createOperation.current?.body !== key)
        createOperation.current = { body: key, id: crypto.randomUUID() };
      const test = await postJson<MathPublicTest>("/api/math/tests", {
        ...body,
        operationId: createOperation.current.id,
      });
      navigate(`/math/tests/${test.id}`, { state: { start: true } });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  async function showPreview(c: MathBook["chapters"][number]) {
    const request = ++previewRequest.current;
    setPreview({ title: `${c.number}. ${c.title}` });
    try {
      const source = await fetchJson<MathSource>(
        `/api/math/chapters/${c.versionId}`,
      );
      if (request === previewRequest.current)
        setPreview({ title: `${c.number}. ${c.title}`, source });
    } catch (err) {
      if (request === previewRequest.current)
        setPreview({ title: c.title, error: describe(err) });
    }
  }
  return (
    <>
      <header className="math-page-heading">
        <Link className="math-back" to="/">
          ← {t("mathCategories")}
        </Link>
        <p className="math-eyebrow">{t("mathLibrary")}</p>
        <h1>{t("mathTitle")}</h1>
        <p>{t("mathContinuousIntro")}</p>
      </header>
      {error && (
        <div role="alert" className="math-error">
          {error}
          <button className="math-button-secondary" onClick={() => void load()}>
            {t("mathReload")}
          </button>
        </div>
      )}
      {loading ? (
        <p role="status" className="math-loading">
          {t("mathLoading")}
        </p>
      ) : (
        <>
          {!books.length && !error && (
            <section className="math-panel math-empty">
              {t("mathNoBooks")}
            </section>
          )}
          {latest && (
            <section className="math-resume-banner">
              <div>
                <span className="math-eyebrow">
                  {t("mathContinueLearning")}
                </span>
                <h2>{latest.title}</h2>
                <p>
                  {new Date(latest.createdAt).toLocaleDateString()} ·{" "}
                  {t(`math_status_${latest.status}`)}
                </p>
              </div>
              <Link
                className="math-button-secondary"
                to={`/math/tests/${latest.id}`}
              >
                {t("mathResume")} →
              </Link>
            </section>
          )}
          {!!books.length && (
            <div className="math-library-grid">
              <section className="math-panel math-chapter-panel">
                <div className="math-section-heading">
                  <div>
                    <p className="math-eyebrow">01 · {t("mathScope")}</p>
                    <h2>{t("mathChapters")}</h2>
                  </div>
                  {book && (
                    <span className="math-count-badge">
                      {selected.length} / {book.chapters.length}
                    </span>
                  )}
                </div>
                <label className="math-label">
                  {t("mathBook")}
                  <select
                    className="math-field"
                    aria-label={t("mathBook")}
                    value={bookId}
                    disabled={busy}
                    onChange={(e) => {
                      setBookId(e.target.value);
                      setSelected([]);
                      previewRequest.current++;
                      setPreview(undefined);
                    }}
                  >
                    <option value="">{t("mathSelectBook")}</option>
                    {books.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.subjectTitle === b.title
                          ? b.title
                          : `${b.subjectTitle} / ${b.title}`}
                      </option>
                    ))}
                  </select>
                </label>
                {book && (
                  <>
                    <div className="math-selection-tools">
                      <p>{t("mathSelectChaptersHelp")}</p>
                      <div>
                        <button
                          disabled={busy}
                          onClick={() =>
                            setSelected(book.chapters.map((c) => c.id))
                          }
                        >
                          {t("mathSelectAll")}
                        </button>
                        <button
                          disabled={busy || !selected.length}
                          onClick={() => setSelected([])}
                        >
                          {t("mathClearSelection")}
                        </button>
                      </div>
                    </div>
                    <fieldset disabled={busy} className="math-chapters">
                      <legend className="sr-only">{t("mathChapters")}</legend>
                      {book.chapters.map((c) => (
                        <div
                          className={`math-chapter ${selected.includes(c.id) ? "is-selected" : ""}`}
                          key={c.id}
                        >
                          <label>
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
                            />
                            <span className="math-chapter-number">
                              {String(c.number).padStart(2, "0")}
                            </span>
                            <span>{c.title}</span>
                          </label>
                          <button
                            type="button"
                            aria-label={`${t("mathPreview")}: ${c.title}`}
                            onClick={() => void showPreview(c)}
                          >
                            {t("mathPreview")}
                          </button>
                        </div>
                      ))}
                    </fieldset>
                    <p className="math-help">{t("mathScopeHelp")}</p>
                  </>
                )}
              </section>
              <aside className="math-start-rail">
                <section className="math-panel">
                  <p className="math-eyebrow">02 · {t("mathReady")}</p>
                  <h2>{t("mathPracticeAtYourPace")}</h2>
                  <p className="math-help">{t("mathNoCountHelp")}</p>
                  {book && (
                    <dl className="math-summary-list">
                      <div>
                        <dt>{t("mathScope")}</dt>
                        <dd>
                          {selected.length} {t("mathSelectedChapters")}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("mathOutputLanguage")}</dt>
                        <dd>
                          {new Intl.DisplayNames([language], {
                            type: "language",
                          }).of(book.language) ?? book.language}
                        </dd>
                      </div>
                    </dl>
                  )}
                  <details className="math-settings">
                    <summary>{t("mathSettings")}</summary>
                    <div>
                      <label className="math-label">
                        {t("mathDifficulty")}
                        <select
                          className="math-field"
                          disabled={busy}
                          value={difficulty}
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
                      <fieldset disabled={busy} className="math-kind-choices">
                        <legend>{t("mathKinds")}</legend>
                        {(
                          ["prove", "determine", "compute", "derive"] as const
                        ).map((k) => (
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
                            />
                            {t(`math_${k}`)}
                          </label>
                        ))}
                      </fieldset>
                    </div>
                  </details>
                  <div className="math-library-start">
                    <button
                      className="math-button-primary"
                      disabled={
                        busy || !book || !selected.length || !kinds.length
                      }
                      onClick={() => void start()}
                    >
                      {busy ? t("mathStarting") : t("mathStartLearning")}{" "}
                      <span aria-hidden>→</span>
                    </button>
                    {!selected.length && (
                      <p className="math-help">{t("mathChooseChapterFirst")}</p>
                    )}
                  </div>
                </section>
              </aside>
            </div>
          )}
          {!!history.length && (
            <section className="math-history-section">
              <div className="math-section-heading">
                <h2>{t("mathHistory")}</h2>
                <span className="math-help">{t("mathHistoryHelp")}</span>
              </div>
              <div className="math-saved-tests">
                {history.map((h) => (
                  <Link
                    key={h.id}
                    className="math-saved-test"
                    to={`/math/tests/${h.id}`}
                  >
                    <div>
                      <h3>{h.title}</h3>
                      <p>{new Date(h.createdAt).toLocaleString()}</p>
                    </div>
                    <span
                      className={`math-status ${h.status === "completed" ? "is-completed" : ""}`}
                    >
                      {t(`math_status_${h.status}`)}
                    </span>
                    <span aria-hidden>→</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {preview && (
        <MathDialog
          title={preview.title}
          onClose={() => {
            previewRequest.current++;
            setPreview(undefined);
          }}
        >
          {preview.source ? (
            <MathText text={preview.source.markdown} />
          ) : preview.error ? (
            <p role="alert" className="math-error">
              {preview.error}
            </p>
          ) : (
            <p role="status">{t("mathLoading")}</p>
          )}
        </MathDialog>
      )}
    </>
  );
}
