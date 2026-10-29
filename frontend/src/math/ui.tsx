import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n/context";
import { ApiError } from "../api/client";
import type { MathBook, MathHistoryItem } from "./types";
import MathText from "./MathText";
export function useMathError() {
  const { t } = useI18n();
  return (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 404) return t("mathNotFound");
      if (err.message.includes("MATH_SCOPE_TOO_LARGE"))
        return t("mathScopeLarge");
      if (err.message.includes("MATH_BUSY")) return t("mathBusy");
      if (/MATH_(CURRICULUM|SOURCE|QUESTION)_MISSING/.test(err.message))
        return t("mathFrozenMissing");
      if (err.message.includes("MATH_PROMPT_VERSION_UNAVAILABLE"))
        return t("mathPromptUnavailable");
      if (err.status === 422) return t("mathNoFeasibleObjective");
      if (err.status === 413) return t("mathScopeLarge");
      if (err.status === 409) return t("mathConflict");
    }
    return t("mathFailure");
  };
}
export function MathDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    ref.current?.showModal();
    const dialog = ref.current;
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="math-dialog"
      aria-label={title}
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="math-icon-button"
          onClick={onClose}
          aria-label={t("mathClose")}
          autoFocus
        >
          ✕
        </button>
      </header>
      <div className="math-dialog-body">{children}</div>
    </dialog>
  );
}
export function QuestionReview({
  item,
  book,
}: {
  item: MathHistoryItem;
  book: MathBook;
}) {
  const { t } = useI18n();
  const { question: q, answer } = item;
  return (
    <div className="math-review-content">
      <div className="math-tags">
        <span>
          {t("mathQuestion")} {item.number}
        </span>
        <span>{t(`math_${q.taskKind ?? q.kind}`)}</span>
        <span>{book.chapters.find((c) => c.id === q.chapterId)?.title}</span>
      </div>
      {q.primaryObjectiveId && (
        <p className="math-help">
          {t("mathObjective")}: {q.objectiveStatement ?? q.primaryObjectiveId} ·{" "}
          {t(`math_${q.difficulty ?? "standard"}`)}
        </p>
      )}
      <MathText text={q.prompt} />
      <section>
        <h3>
          {t("mathYourAnswer")}
          {answer?.submitted === false ? ` · ${t("mathUnsubmitted")}` : ""}
        </h3>
        <MathText text={answer?.text || t("mathUnanswered")} />
      </section>
      {answer?.grade && (
        <section
          className={`math-feedback math-verdict-${answer.grade.verdict}`}
        >
          <h3>{t(`math_${answer.grade.verdict}`)}</h3>
          <MathText text={answer.grade.feedback} />
        </section>
      )}
      {q.solution && (
        <section>
          <h3>{t("mathSolution")}</h3>
          <MathText text={q.solution} />
        </section>
      )}
      {q.solution && (
        <p className="math-source">
          {t("mathSource")}: {q.heading}
        </p>
      )}
    </div>
  );
}
