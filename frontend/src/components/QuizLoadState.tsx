import { useI18n } from "../i18n/context";

interface Props {
  /** Whether a chunk failed. When true, only the retry affordance is shown. */
  error: boolean;
  loaded: number;
  total: number;
  onRetry: () => void;
}

/**
 * The full-screen state shown before the first card is ready.
 *
 * Replaces a hard-coded `"Loading questions..."` that had no error branch at all — its initial
 * fetch carried no `.catch`, so any failure left the user staring at that line forever with no
 * way out. Shared by all three quiz screens.
 */
export default function QuizLoadState({ error, loaded, total, onRetry }: Props) {
  const { t } = useI18n();

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 text-center">
      {error ? (
        <>
          <p className="text-gray-300">{t("quizLoadFailed")}</p>
          <p className="max-w-xs text-sm text-gray-500">{t("quizLoadFailedHint")}</p>
          <button
            onClick={onRetry}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            {t("retry")}
          </button>
        </>
      ) : (
        <>
          <p className="text-gray-400">{t("preparingQuestions")}</p>
          {total > 0 && (
            <>
              <div className="h-1.5 w-48 overflow-hidden rounded-full bg-gray-700">
                <div
                  className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
                  style={{ width: `${Math.round((loaded / total) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-gray-500">
                {loaded} / {total}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
