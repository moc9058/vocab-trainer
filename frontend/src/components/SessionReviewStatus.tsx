import { useI18n } from "../i18n/context";
import { flushAnswers } from "../utils/answerOutbox";

export default function SessionReviewStatus({ review }: { review: {
  pending: boolean; error: "conflict" | "missing" | "load" | null; reload: () => void;
} }) {
  const { t } = useI18n();
  return <div role="status" className="flex min-h-full flex-col items-center justify-center gap-4 p-8 text-center text-gray-300">
    <p>{t(review.pending ? "savingReview" : review.error === "conflict" ? "reviewConflict"
      : review.error === "missing" ? "reviewMissing" : "reviewSaveFailed")}</p>
    <button onClick={review.pending ? flushAnswers : review.reload}
      className="rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-500">{t("retry")}</button>
  </div>;
}
