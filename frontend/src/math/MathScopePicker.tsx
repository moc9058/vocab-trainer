import { useI18n } from "../i18n/context";
import type { MathBook, MathScopeInput, MathChapter } from "./types";
export default function MathScopePicker({
  books,
  value,
  onChange,
  disabled = false,
  onPreview,
}: {
  books: MathBook[];
  value: MathScopeInput[];
  onChange: (value: MathScopeInput[]) => void;
  disabled?: boolean;
  onPreview?: (book: MathBook, chapter: MathChapter) => void;
}) {
  const { t } = useI18n();
  const update = (book: MathBook, chapterIds: string[]) =>
    onChange([
      ...value.filter((s) => s.bookId !== book.id),
      ...(chapterIds.length ? [{ bookId: book.id, chapterIds }] : []),
    ]);
  return (
    <div className="math-scope-picker">
      {books.map((book) => {
        const selected =
          value.find((s) => s.bookId === book.id)?.chapterIds ?? [];
        return (
          <details
            key={book.id}
            className={`math-scope-book ${selected.length ? "has-selection" : ""}`}
          >
            <summary className="math-scope-toggle">
              <span className="math-scope-heading">
                <span className="math-scope-subject">{book.subjectTitle}</span>
                <span className="math-scope-title">{book.title}</span>
                <span className="math-scope-count">
                  {selected.length}/{book.chapters.length} {t("mathSelectedChapters")}
                </span>
              </span>
              <span className="math-scope-toggle-action">
                <span className="math-scope-show">{t("mathExpandChapters")}</span>
                <span className="math-scope-hide">{t("mathCollapseChapters")}</span>
                <span className="math-scope-chevron" aria-hidden>⌄</span>
              </span>
            </summary>
            <fieldset
              disabled={disabled || !book.publicationId}
              className="math-scope-content"
              aria-label={book.title}
            >
              <legend className="sr-only">{book.title}</legend>
              <p className="math-help">{t("mathSelectChaptersHelp")}</p>
              <div className="math-scope-selection">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`${t("mathSelectAll")}: ${book.title}`}
                    ref={(input) => {
                      if (input)
                        input.indeterminate =
                          selected.length > 0 &&
                          selected.length < book.chapters.length;
                    }}
                    disabled={disabled || !book.publicationId}
                    checked={
                      selected.length > 0 && selected.length === book.chapters.length
                    }
                    onChange={(e) =>
                      update(
                        book,
                        e.target.checked ? book.chapters.map((c) => c.id) : [],
                      )
                    }
                  />{" "}
                  {t("mathSelectAll")}
                </label>
              </div>
              {!book.publicationId && (
                <p className="math-help">{t("mathCurriculumRequired")}</p>
              )}
              <div className="math-chapters">
                {book.chapters.map((c) => (
                  <div
                    className={`math-chapter ${selected.includes(c.id) ? "is-selected" : ""}`}
                    key={c.id}
                  >
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`${book.title} / ${c.number}. ${c.title}`}
                        checked={selected.includes(c.id)}
                        onChange={(e) =>
                          update(
                            book,
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
                    {onPreview && (
                      <button
                        type="button"
                        aria-label={`${t("mathPreview")}: ${book.title} / ${c.title}`}
                        onClick={() => onPreview(book, c)}
                      >
                        {t("mathPreview")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </fieldset>
          </details>
        );
      })}
    </div>
  );
}
