import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { getGrammarChapters, getSubchapters } from "../api/grammar";
import type { GrammarChapterInfo } from "../types";

interface SubchapterInfo {
  chapterNumber: number;
  subchapterId: string;
  subchapterTitle: Record<string, string>;
}

interface Props {
  language: string;
  onStart: (filters: {
    chapters: number[];
    subchapters: string[];
    displayLanguage: string;
    quizMode: string;
  }) => void;
  onClose: () => void;
}

export default function GrammarFilterModal({ language, onStart, onClose }: Props) {
  const { t, language: uiLang } = useI18n();
  const [chapters, setChapters] = useState<GrammarChapterInfo[]>([]);
  const [selectedChapters, setSelectedChapters] = useState<Set<number>>(new Set());
  const [subchapterData, setSubchapterData] = useState<SubchapterInfo[]>([]);
  const [selectedSubchapters, setSelectedSubchapters] = useState<Set<string>>(new Set());
  const [displayLanguage, setDisplayLanguage] = useState("ja");
  const [quizMode, setQuizMode] = useState("existing");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGrammarChapters(language)
      .then(setChapters)
      .catch(() => setChapters([]))
      .finally(() => setLoading(false));
  }, [language]);

  // Fetch subchapters when selected chapters change
  useEffect(() => {
    const chapterNums = [...selectedChapters];
    if (chapterNums.length === 0) {
      setSubchapterData([]);
      setSelectedSubchapters(new Set());
      return;
    }
    getSubchapters(language, chapterNums)
      .then((subs) => {
        setSubchapterData(subs);
        // Auto-select all subchapters for newly selected chapters
        setSelectedSubchapters((prev) => {
          const next = new Set(prev);
          for (const s of subs) {
            if (!next.has(s.subchapterId) && selectedChapters.has(s.chapterNumber)) {
              next.add(s.subchapterId);
            }
          }
          // Remove subchapters from deselected chapters
          const validIds = new Set(subs.map((s) => s.subchapterId));
          for (const id of next) {
            if (!validIds.has(id)) next.delete(id);
          }
          return next;
        });
      })
      .catch(() => setSubchapterData([]));
  }, [language, selectedChapters]);

  function toggleChapter(num: number) {
    setSelectedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(num)) {
        next.delete(num);
        // Deselect subchapters for this chapter
        setSelectedSubchapters((prevSubs) => {
          const nextSubs = new Set(prevSubs);
          for (const s of subchapterData) {
            if (s.chapterNumber === num) nextSubs.delete(s.subchapterId);
          }
          return nextSubs;
        });
      } else {
        next.add(num);
      }
      return next;
    });
  }

  function toggleSubchapter(id: string) {
    setSelectedSubchapters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Group subchapters by chapter
  const subsByChapter = new Map<number, SubchapterInfo[]>();
  for (const s of subchapterData) {
    if (!subsByChapter.has(s.chapterNumber)) subsByChapter.set(s.chapterNumber, []);
    subsByChapter.get(s.chapterNumber)!.push(s);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-gray-800 p-4 sm:p-6 shadow-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t("selectGrammarFilters")}
        </h2>

        {loading ? (
          <p className="text-gray-400">Loading...</p>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-4">
            {/* Chapters + Subchapters */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-300">{t("grammarChapters")}</h3>
                <button
                  onClick={() => {
                    if (selectedChapters.size === chapters.length) {
                      setSelectedChapters(new Set());
                      setSelectedSubchapters(new Set());
                    } else {
                      setSelectedChapters(new Set(chapters.map((c) => c.chapterNumber)));
                    }
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {selectedChapters.size === chapters.length ? t("clearAll") : t("selectAll")}
                </button>
              </div>
              <div className="space-y-1">
                {chapters.map((ch) => (
                  <div key={ch.chapterNumber}>
                    <label className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedChapters.has(ch.chapterNumber)}
                        onChange={() => toggleChapter(ch.chapterNumber)}
                        className="accent-blue-600"
                      />
                      {ch.chapterTitle[uiLang] || ch.chapterTitle.en || ch.chapterTitle.ja}
                    </label>
                    {/* Subchapters nested under selected chapter */}
                    {selectedChapters.has(ch.chapterNumber) && subsByChapter.has(ch.chapterNumber) && (
                      <div className="ml-6 space-y-0.5">
                        {subsByChapter.get(ch.chapterNumber)!.map((sub) => (
                          <label key={sub.subchapterId} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedSubchapters.has(sub.subchapterId)}
                              onChange={() => toggleSubchapter(sub.subchapterId)}
                              className="accent-blue-600"
                            />
                            {sub.subchapterTitle[uiLang] || sub.subchapterTitle.en || sub.subchapterTitle.ja || sub.subchapterId}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Display Language */}
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-2">{t("displayLanguage")}</h3>
              <div className="flex gap-3">
                {[
                  { value: "en", label: "English" },
                  { value: "ja", label: "Japanese" },
                  { value: "ko", label: "Korean" },
                ].map((opt) => (
                  <label key={opt.value} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="radio"
                      name="displayLanguage"
                      value={opt.value}
                      checked={displayLanguage === opt.value}
                      onChange={() => setDisplayLanguage(opt.value)}
                      className="accent-blue-600"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            {/* Quiz Mode — hidden for Chinese (always LLM) */}
            {language !== "chinese" && (
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-2">{t("quizMode")}</h3>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="radio"
                      name="quizMode"
                      value="existing"
                      checked={quizMode === "existing"}
                      onChange={() => setQuizMode("existing")}
                      className="accent-blue-600"
                    />
                    {t("quizModeExisting")}
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="radio"
                      name="quizMode"
                      value="llm"
                      checked={quizMode === "llm"}
                      onChange={() => setQuizMode("llm")}
                      className="accent-blue-600"
                    />
                    {t("quizModeLLM")}
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {selectedChapters.size === 0 && !loading && (
          <p className="mt-3 text-xs text-gray-400">{t("allGrammarHint")}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-1.5 text-sm text-gray-300 hover:bg-gray-700"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() =>
              onStart({
                chapters: [...selectedChapters],
                subchapters: [...selectedSubchapters],
                displayLanguage,
                quizMode: language === "chinese" ? "llm" : quizMode,
              })
            }
            disabled={loading}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {t("startGrammarQuiz")}
          </button>
        </div>
      </div>
    </div>
  );
}
