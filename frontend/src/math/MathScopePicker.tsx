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
          <fieldset
            key={book.id}
            disabled={disabled || !book.publicationId}
            className="math-scope-book"
          >
            <legend>
              <label>
                <input
                  type="checkbox"
                  disabled={disabled || !book.publicationId}
                  checked={selected.length > 0}
                  onChange={(e) =>
                    update(
                      book,
                      e.target.checked ? book.chapters.map((c) => c.id) : [],
                    )
                  }
                />{" "}
                {book.title}
              </label>
            </legend>
            {!book.publicationId && (
              <p className="math-help">{t("mathCurriculumRequired")}</p>
            )}
            <p className="math-help">
              {book.subjectTitle} · {selected.length}/{book.chapters.length}
            </p>
            <div className="math-selection-tools">
              <button
                type="button"
                onClick={() =>
                  update(
                    book,
                    book.chapters.map((c) => c.id),
                  )
                }
              >
                {t("mathSelectAll")}
              </button>
              <button type="button" onClick={() => update(book, [])}>
                {t("mathClearSelection")}
              </button>
            </div>
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
        );
      })}
    </div>
  );
}
