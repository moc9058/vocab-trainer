import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { fetchJson } from "../api/client";

interface LanguageInfo {
  filename: string;
  language: string;
  wordCount: number;
}

export default function LanguageSelectPage() {
  const { t } = useI18n();
  const { sortByLanguageOrder } = useSettings();
  const navigate = useNavigate();
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [loading, setLoading] = useState(true);

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
    </div>
  );
}
