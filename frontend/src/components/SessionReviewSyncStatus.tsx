import { useI18n } from "../i18n/context";
import { flushAnswers } from "../utils/answerOutbox";

/** Saving never covers the review card or disables Next. */
export default function SessionReviewSyncStatus({ syncing, complete = false }: {
  syncing: boolean; complete?: boolean;
}) {
  const { t } = useI18n();
  if (!syncing) return null;
  return <button onClick={flushAnswers} role="status"
    className="max-w-lg rounded-lg bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-300">
    {t(complete ? "reviewSyncBeforeContinue" : "reviewSyncPending")}
  </button>;
}
