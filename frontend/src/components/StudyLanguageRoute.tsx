import { Link, useParams } from "react-router-dom";
import Dashboard from "./Dashboard";
import { useI18n } from "../i18n/context";
import { useAnswerOutbox } from "../hooks/useAnswerOutbox";
import { isStudyLanguagePaused } from "../utils/studyLanguageAvailability";
import { isNative } from "../platform/native";

function PausedLanguagePage() {
  const { t } = useI18n();
  const outbox = useAnswerOutbox();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-900 p-6 text-center text-gray-100">
      <h1 className="text-2xl font-bold">{t("englishVersionPaused")}</h1>
      <p className="max-w-lg text-gray-400">{t("englishVersionPausedHint")}</p>
      {!isNative() && (outbox.pending > 0 || outbox.failed > 0) && (
        <div role="status" className="rounded-lg bg-amber-950 p-4 text-sm text-amber-100">
          {outbox.pending > 0 && <>
            <button onClick={outbox.flush} className="min-h-11 underline" title={t("unsyncedAnswersHint")}>
              {t("unsyncedAnswers").replace("{n}", String(outbox.pending))}
            </button>
            <p>{t(outbox.authBlocked ? "syncNeedsLogin" : "unsyncedAnswersHint")}</p>
          </>}
          {outbox.failed > 0 && <button onClick={outbox.acknowledgeFailed} className="block min-h-11 underline">
            {t("unsyncableAnswers").replace("{n}", String(outbox.failed))}
          </button>}
        </div>
      )}
      <Link to="/" className="rounded-lg border border-gray-600 px-4 py-3 hover:bg-gray-800">← {t("languages")}</Link>
    </main>
  );
}

export default function StudyLanguageRoute() {
  const { language = "" } = useParams<{ language: string }>();
  // Decide before mounting Dashboard: none of its recovery effects or editors
  // should run for a paused study language, including bookmarked child routes.
  return isStudyLanguagePaused(language) ? <PausedLanguagePage /> : <Dashboard />;
}
