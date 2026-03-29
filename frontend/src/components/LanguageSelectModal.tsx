import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { fetchJson } from "../api/client";

interface LanguageInfo {
  filename: string;
  language: string;
  topics: string[];
  wordCount: number;
}

interface Props {
  onSelect: (language: string) => void;
  onClose: () => void;
}

export default function LanguageSelectModal({ onSelect, onClose }: Props) {
  const { t } = useI18n();
  const { sortByLanguageOrder } = useSettings();
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<LanguageInfo[]>("/api/languages/")
      .then((langs) => setLanguages(sortByLanguageOrder(langs, (l) => l.filename.replace(/\.json$/, ""))))
      .catch(() => setLanguages([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t("selectQuizLanguage")}
        </h2>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : languages.length === 0 ? (
          <p className="text-gray-400">No languages available.</p>
        ) : (
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {languages.map((lang) => (
              <li key={lang.filename}>
                <button
                  onClick={() =>
                    onSelect(lang.filename.replace(/\.json$/, ""))
                  }
                  className="w-full rounded-lg border border-gray-700 px-4 py-3 text-left hover:border-blue-500 hover:bg-gray-700"
                >
                  <span className="font-medium text-gray-100">
                    {lang.language}
                  </span>
                  <span className="ml-2 text-xs text-gray-400">
                    {lang.wordCount} {t("words")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
