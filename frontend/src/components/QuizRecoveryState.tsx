import { useI18n } from "../i18n/context";

interface Props {
  /** The session refetch failed at the transport level — almost always: no connection. */
  error: boolean;
  onRetry: () => void;
  onHome: () => void;
}

/**
 * Shown on a quiz sub-path while its session is being recovered after a refresh or a deep link.
 *
 * The error branch exists because the recovery effects used to redirect home on ANY failure —
 * and since the session getters swallowed every error into `null`, being offline was
 * indistinguishable from having no session. Refreshing on a weak connection therefore looked
 * exactly like the quiz having disappeared.
 */
export default function QuizRecoveryState({ error, onRetry, onHome }: Props) {
  const { t } = useI18n();

  if (!error) {
    return (
      <div className="flex items-center justify-center p-8">
        <span className="text-gray-400">{t("resumingQuiz")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-gray-300">{t("quizResumeFailed")}</p>
      <p className="max-w-xs text-sm text-gray-500">{t("quizResumeFailedHint")}</p>
      <div className="flex gap-3">
        <button
          onClick={onRetry}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          {t("retry")}
        </button>
        <button
          onClick={onHome}
          className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800"
        >
          {t("backToHome")}
        </button>
      </div>
    </div>
  );
}
