import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getFilters } from "../api/vocab";

interface Props {
  language: string;
  onStart: (filters: { topics: string[]; categories: string[] }) => void;
  onBack: () => void;
  onClose: () => void;
}

export default function QuizFilterModal({ language, onStart, onBack, onClose }: Props) {
  const { t } = useI18n();
  const [allTopics, setAllTopics] = useState<string[]>([]);
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(new Set());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getFilters(language)
      .then(({ topics, categories }) => {
        setAllTopics(topics);
        setAllCategories(categories);
      })
      .catch(() => {
        setAllTopics([]);
        setAllCategories([]);
      })
      .finally(() => setLoading(false));
  }, [language]);

  function toggleTopic(topic: string) {
    setSelectedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  }

  function toggleCategory(cat: string) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  const hasSelection = selectedTopics.size > 0 || selectedCategories.size > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t("selectFilters")}
        </h2>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : (
          <div className="flex flex-col md:flex-row flex-1 gap-4 md:gap-6 overflow-hidden">
            {/* Topics column */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-300">{t("topicsColumn")}</h3>
                <button
                  onClick={() =>
                    setSelectedTopics(
                      selectedTopics.size === allTopics.length ? new Set() : new Set(allTopics)
                    )
                  }
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {selectedTopics.size === allTopics.length ? t("clearAll") : t("selectAll")}
                </button>
              </div>
              <ul className="flex-1 overflow-y-auto space-y-1">
                {allTopics.map((topic) => (
                  <li key={topic}>
                    <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedTopics.has(topic)}
                        onChange={() => toggleTopic(topic)}
                        className="accent-blue-600"
                      />
                      {topic}
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            {/* Categories column */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-300">{t("grammarColumn")}</h3>
                <button
                  onClick={() =>
                    setSelectedCategories(
                      selectedCategories.size === allCategories.length ? new Set() : new Set(allCategories)
                    )
                  }
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {selectedCategories.size === allCategories.length ? t("clearAll") : t("selectAll")}
                </button>
              </div>
              <ul className="flex-1 overflow-y-auto space-y-1">
                {allCategories.map((cat) => (
                  <li key={cat}>
                    <label className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedCategories.has(cat)}
                        onChange={() => toggleCategory(cat)}
                        className="accent-blue-600"
                      />
                      {cat}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {!hasSelection && !loading && (
          <p className="mt-3 text-xs text-gray-400">{t("allWordsHint")}</p>
        )}

        <div className="mt-4 flex justify-between">
          <button
            onClick={onBack}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("back")}
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
            >
              {t("cancel")}
            </button>
            <button
              onClick={() =>
                onStart({
                  topics: [...selectedTopics],
                  categories: [...selectedCategories],
                })
              }
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {t("startQuiz")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
