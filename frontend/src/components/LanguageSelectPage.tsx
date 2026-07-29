import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { useAuth } from "../auth/context";
import { fetchJson } from "../api/client";
import MetricsView from "./MetricsView";

interface LanguageInfo {
  filename: string;
  language: string;
  wordCount: number;
}

export default function LanguageSelectPage() {
  const { t } = useI18n();
  const { sortByLanguageOrder } = useSettings();
  const { user, authEnabled, logout } = useAuth();
  const navigate = useNavigate();
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showMetrics, setShowMetrics] = useState(false);

  useEffect(() => {
    fetchJson<LanguageInfo[]>("/api/languages/")
      .then((langs) => setLanguages(sortByLanguageOrder(langs, (l) => l.filename.replace(/\.json$/, ""))))
      .catch(() => setLanguages([]))
      .finally(() => setLoading(false));
  }, []);

  function handleSelect(filename: string) {
    const key = filename.replace(/\.json$/, "");
    navigate(`/${key}`);
  }

  if (showMetrics) {
    return (
      <div className="flex min-h-screen flex-col bg-gray-900">
        <div className="flex items-center gap-3 border-b border-gray-700 px-4 py-3">
          <button
            onClick={() => setShowMetrics(false)}
            className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            ← {t("back") ?? "Back"}
          </button>
          <span className="text-sm font-medium text-gray-400">{t("sectionSystem") ?? "System"}</span>
        </div>
        <MetricsView />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-900 p-6">
      <h1 className="mb-2 text-3xl font-bold text-gray-100">{t("appTitle")}</h1>
      <p className="mb-10 text-gray-400">{t("selectQuizLanguage")}</p>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : languages.length === 0 ? (
        <p className="text-gray-500">No languages available.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {languages.map((lang) => (
            <button
              key={lang.filename}
              onClick={() => handleSelect(lang.filename)}
              className="w-56 rounded-xl border border-gray-700 bg-gray-800 px-6 py-8 text-center hover:border-blue-500 hover:bg-gray-700 transition-colors"
            >
              <p className="text-xl font-semibold text-gray-100">{lang.language}</p>
              <p className="mt-1 text-sm text-gray-400">{lang.wordCount} {t("words")}</p>
            </button>
          ))}
        </div>
      )}

      <div className="mt-10 w-full max-w-sm">
        <section className="rounded-xl bg-gray-800/60 p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            {t("sectionSystem") ?? "System"}
          </h3>
          <button
            onClick={() => setShowMetrics(true)}
            className="w-full rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t("viewMetrics") ?? "LLM Usage & Costs"}
          </button>
          {authEnabled && (
            <>
              <p className="mt-3 truncate text-center text-xs text-gray-500">
                {t("signedInAs") ?? "Signed in as"} {user?.email}
              </p>
              <button
                onClick={logout}
                className="mt-2 w-full rounded-lg border border-gray-700 px-4 py-2 text-center text-sm text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
              >
                {t("signOut") ?? "Sign out"}
              </button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
