import { useI18n } from "../i18n/context";
import type { QuizPrefetchResult } from "../hooks/useQuizPrefetch";

interface Props {
  prefetch: Pick<QuizPrefetchResult, "loading" | "loaded" | "total" | "error" | "retry">;
  /** Answers waiting to reach the server. */
  pending: number;
  /** Answers the server refused; retrying will not help. */
  failed: number;
  onFlush: () => void;
  onAcknowledgeFailed: () => void;
}

/**
 * The two "the network is behind" indicators, shown side by side above the question.
 *
 * Both are deliberately quiet: the quiz is fully playable in either state, so this is status,
 * not an error the user has to act on. It renders nothing at all once everything is loaded and
 * every answer has synced, which is the normal case.
 */
export default function QuizSyncBadge({
  prefetch,
  pending,
  failed,
  onFlush,
  onAcknowledgeFailed,
}: Props) {
  const { t } = useI18n();
  const showPrefetch = prefetch.error || (prefetch.loading && prefetch.total > prefetch.loaded);
  if (!showPrefetch && pending === 0 && failed === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center justify-center gap-2 text-xs">
      {showPrefetch &&
        (prefetch.error ? (
          <button
            onClick={prefetch.retry}
            className="rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-300 hover:bg-amber-500/20"
          >
            {t("quizPrefetchStalled")} · {t("retry")}
          </button>
        ) : (
          <span className="rounded-full bg-gray-700/60 px-2.5 py-1 text-gray-400">
            {t("loadingRest")} {prefetch.loaded}/{prefetch.total}
          </span>
        ))}

      {pending > 0 && (
        <button
          onClick={onFlush}
          title={t("unsyncedAnswersHint")}
          className="rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-300 hover:bg-amber-500/20"
        >
          {t("unsyncedAnswers").replace("{n}", String(pending))}
        </button>
      )}

      {failed > 0 && (
        <button
          onClick={onAcknowledgeFailed}
          className="rounded-full bg-red-500/10 px-2.5 py-1 text-red-300 hover:bg-red-500/20"
        >
          {t("unsyncableAnswers").replace("{n}", String(failed))}
        </button>
      )}
    </div>
  );
}
