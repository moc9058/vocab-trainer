import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getFilters } from "../api/vocab";

interface Props {
  language: string;
  onSelect: (levels: string[]) => void;
  onBack: () => void;
  onClose: () => void;
}

export default function LevelSelectModal({ language, onSelect, onBack, onClose }: Props) {
  const { t } = useI18n();
  const [allLevels, setAllLevels] = useState<string[]>([]);
  const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getFilters(language)
      .then(({ levels }) => setAllLevels(levels))
      .catch(() => setAllLevels([]))
      .finally(() => setLoading(false));
  }, [language]);

  function toggleLevel(level: string) {
    setSelectedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  const allSelected = allLevels.length > 0 && selectedLevels.size === allLevels.length;

  function toggleAll() {
    setSelectedLevels(allSelected ? new Set() : new Set(allLevels));
  }

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
          {t("selectLevel")}
        </h2>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : allLevels.length === 0 ? (
          <p className="text-gray-400">No levels available.</p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            <li>
              <label className="flex items-center gap-2 rounded px-2 py-2 text-sm cursor-pointer hover:bg-gray-700">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-blue-600"
                />
                <span className="font-medium text-blue-300">{t("allLevels")}</span>
              </label>
            </li>
            {allLevels.map((level) => (
              <li key={level}>
                <label className="flex items-center gap-2 rounded px-2 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedLevels.has(level)}
                    onChange={() => toggleLevel(level)}
                    className="accent-blue-600"
                  />
                  {level}
                </label>
              </li>
            ))}
          </ul>
        )}

        {selectedLevels.size === 0 && !loading && allLevels.length > 0 && (
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
              onClick={() => onSelect([...selectedLevels])}
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {t("next")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
