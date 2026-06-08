import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP } from "../settings/defaults";
import { getFlaggedWordIds, getFlaggedWords } from "../api/flagged";
import { unflagWord } from "../api/flagged";
import { getGroups } from "../api/vocab";
import RubyText from "./RubyText";
import QuizFilterModal from "./QuizFilterModal";
import type { Word } from "../types";

interface Props {
  language: string;
  onBack: () => void;
}

type Filters = { topics: string[]; categories: string[]; levels: string[]; groupIds: string[] };
const VISIBLE_ANSWER_ITEMS = 4;

function pickRandom(words: Word[], excludeId?: string): Word | null {
  const pool = excludeId ? words.filter((w) => w.id !== excludeId) : words;
  if (pool.length === 0) return words[0] ?? null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function TranslationDisplay({ translation }: { translation: string | Record<string, string> }) {
  const { displayExEntries } = useSettings();
  if (!translation) return null;
  if (typeof translation === "string") return <p className="text-sm text-gray-400">{translation}</p>;
  return (
    <>
      {displayExEntries(translation).map(([lang, text]) => (
        <p key={lang} className="text-sm text-gray-400">
          <span className="text-xs font-medium uppercase text-gray-500 mr-1">{lang}</span>{text}
        </p>
      ))}
    </>
  );
}

async function applyFilters(words: Word[], filters: Filters, language: string): Promise<Word[]> {
  const hasLevel = filters.levels.length > 0;
  const hasTopic = filters.topics.length > 0;
  const hasCat = filters.categories.length > 0;
  const hasGroup = filters.groupIds.length > 0;

  if (!hasLevel && !hasTopic && !hasCat && !hasGroup) return words;

  let groupWordIds: Set<string> | null = null;
  if (hasGroup) {
    const groups = await getGroups(language);
    const selected = groups.filter((g) => filters.groupIds.includes(g.id));
    const union = new Set<string>();
    for (const g of selected) for (const id of g.wordIds) union.add(id);
    groupWordIds = union;
  }

  return words.filter((w) => {
    if (groupWordIds && !groupWordIds.has(w.id)) return false;
    if (hasLevel && (!w.level || !filters.levels.includes(w.level))) return false;
    if (hasTopic || hasCat) {
      const topicMatch = hasTopic && w.topics.some((t) => filters.topics.includes(t));
      const catMatch = hasCat && w.definitions.some((d) => filters.categories.includes(d.partOfSpeech));
      if (!topicMatch && !catMatch) return false;
    }
    return true;
  });
}

export default function FlaggedReview({ language, onBack }: Props) {
  const { t } = useI18n();
  const { settings, displayDefEntries } = useSettings();
  const [filters, setFilters] = useState<Filters | null>(null);
  const [flaggedWordIds, setFlaggedWordIds] = useState<Set<string> | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [currentWord, setCurrentWord] = useState<Word | null>(null);
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [showAllDefinitions, setShowAllDefinitions] = useState(false);
  const [showAllExamples, setShowAllExamples] = useState(false);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);

  useEffect(() => {
    setFlaggedWordIds(null);
    getFlaggedWordIds(language)
      .then(({ wordIds }) => setFlaggedWordIds(new Set(wordIds)))
      .catch(() => setFlaggedWordIds(new Set()));
  }, [language]);

  useEffect(() => {
    if (filters === null) return;
    setLoading(true);
    getFlaggedWords(language)
      .then(async ({ words: flagged }) => {
        const filtered = await applyFilters(flagged, filters, language);
        setWords(filtered);
        setCurrentWord(filtered.length > 0 ? filtered[Math.floor(Math.random() * filtered.length)] : null);
      })
      .catch(() => setWords([]))
      .finally(() => setLoading(false));
  }, [language, filters]);

  function resetExpandedAnswers() {
    setShowAllDefinitions(false);
    setShowAllExamples(false);
  }

  function revealAnswer() {
    if (!currentWord) return;
    resetExpandedAnswers();
    setShowingAnswer(true);
  }

  const nextWord = useCallback(() => {
    setCurrentWord((prev) => pickRandom(words, prev?.id));
    setShowingAnswer(false);
    resetExpandedAnswers();
  }, [words]);

  async function handleRemove() {
    if (!currentWord || removingRef.current) return;
    removingRef.current = true;
    setRemoving(true);
    try {
      await unflagWord(language, currentWord.id);
      setFlaggedWordIds((prev) => {
        const next = new Set(prev ?? []);
        next.delete(currentWord.id);
        return next;
      });
      const remaining = words.filter((w) => w.id !== currentWord.id);
      setWords(remaining);
      setCurrentWord(remaining.length > 0 ? remaining[Math.floor(Math.random() * remaining.length)] : null);
      setShowingAnswer(false);
      resetExpandedAnswers();
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!showingAnswer) {
        if (currentWord && !event.repeat && (event.key === " " || event.code === "Space")) {
          event.preventDefault();
          revealAnswer();
        }
        return;
      }

      if (!currentWord || removingRef.current || event.repeat) return;
      if (event.key === "1") {
        event.preventDefault();
        nextWord();
      } else if (event.key === "2") {
        event.preventDefault();
        void handleRemove();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showingAnswer, currentWord, removing, nextWord, handleRemove]);

  function handleFiltersSelected(f: Filters) {
    setFilters(f);
    setShowingAnswer(false);
    resetExpandedAnswers();
  }

  function handleChangeFilters() {
    setWords([]);
    setCurrentWord(null);
    setFilters(null);
    resetExpandedAnswers();
  }

  if (filters === null) {
    return (
      <QuizFilterModal
        language={language}
        onStart={handleFiltersSelected}
        onClose={onBack}
        startLabel={t("startReview")}
        groupCountMode="flagged"
        flaggedWordIds={flaggedWordIds}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (words.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("noFlaggedWords")}</h2>
        <div className="flex gap-3">
          <button
            onClick={handleChangeFilters}
            className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700"
          >
            {t("selectFilters")}
          </button>
          <button
            onClick={onBack}
            className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700"
          >
            {t("back")}
          </button>
        </div>
      </div>
    );
  }

  const definitions = currentWord?.definitions ?? [];
  const examples = currentWord?.examples ?? [];
  const visibleDefinitions = showAllDefinitions ? definitions : definitions.slice(0, VISIBLE_ANSWER_ITEMS);
  const visibleExamples = showAllExamples ? examples : examples.slice(0, VISIBLE_ANSWER_ITEMS);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <div className="flex items-center gap-3">
        <p className="text-sm text-gray-400">
          {words.length} {t("flaggedWords").toLowerCase()}
        </p>
        <button
          onClick={handleChangeFilters}
          className="text-xs text-blue-400 hover:text-blue-300 border border-gray-600 rounded px-2 py-0.5"
        >
          {t("selectFilters")}
        </button>
      </div>
      <h2 className="text-xl sm:text-3xl font-bold text-gray-100">{currentWord!.term}</h2>

      {!showingAnswer ? (
        <button
          onClick={revealAnswer}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showAnswer")}
        </button>
      ) : (
        <>
          {settings.showKoreanHanja && currentWord!.hanjaReadings && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-px flex-1 bg-amber-500/50"></div>
                <span className="text-xs font-semibold text-amber-400">🀄 {t("sectionKoreanHanja")}</span>
                <div className="h-px flex-1 bg-amber-500/50"></div>
              </div>
              {currentWord!.hanjaReadings.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-3">
                  {currentWord!.hanjaReadings.map((r, i) => (
                  <div key={i} className="flex flex-col items-center rounded-lg bg-gray-800 px-3 py-2 text-center min-w-[56px]">
                    <div className="flex items-baseline gap-1 text-base font-medium text-gray-100">
                      <span>{r.simplifiedChar}</span>
                      {r.simplifiedChar !== r.traditionalChar && (
                        <>
                          <span className="text-xs text-gray-500">→</span>
                          <span className="text-amber-300">{r.traditionalChar}</span>
                        </>
                      )}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {r.hunEum.map((h, j) => (
                        <p key={j} className="text-xs text-gray-400">{h}</p>
                      ))}
                    </div>
                  </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-sm text-gray-400">{t("noKoreanHanja")}</p>
              )}
            </div>
          )}
          <div className="text-center space-y-2">
            {visibleDefinitions.map((m, mi) => (
              <div key={mi}>
                {m.partOfSpeech && <p className="text-xs text-gray-500 italic">{m.partOfSpeech}</p>}
                {(() => {
                  const py = m.pinyins && m.pinyins.length > 0
                    ? m.pinyins.join(" / ")
                    : (mi === 0 ? currentWord!.transliteration : undefined);
                  return py ? <p className="text-sm text-gray-400">{py}</p> : null;
                })()}
                {displayDefEntries(m.text || {}).map(([lang, text]) => (
                  <p key={lang} className="text-xl text-green-400">
                    <span className="text-sm text-gray-400">{LANG_LABEL_MAP[lang] || lang}: </span>{text}
                  </p>
                ))}
              </div>
            ))}
            {definitions.length > VISIBLE_ANSWER_ITEMS && (
              <button
                type="button"
                onClick={() => setShowAllDefinitions((v) => !v)}
                className="mt-1 rounded-md border border-gray-600 bg-gray-700/60 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600 hover:text-gray-100"
              >
                {showAllDefinitions
                  ? `▲ ${t("showFewerDefinitions")}`
                  : `▼ ${t("showMoreDefinitions")} (${definitions.length - VISIBLE_ANSWER_ITEMS})`}
              </button>
            )}
          </div>

          {examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
              {visibleExamples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100">
                    <RubyText text={ex.sentence} segments={ex.segments} />
                  </p>
                  <TranslationDisplay translation={ex.translation} />
                </div>
              ))}
              {examples.length > VISIBLE_ANSWER_ITEMS && (
                <button
                  type="button"
                  onClick={() => setShowAllExamples((v) => !v)}
                  className="mt-2 w-full rounded-md border border-gray-600 bg-gray-600/30 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-600/60 hover:text-gray-100"
                >
                  {showAllExamples
                    ? `▲ ${t("showFewerExamples")}`
                    : `▼ ${t("showMoreExamples")} (${examples.length - VISIBLE_ANSWER_ITEMS})`}
                </button>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
            <button
              onClick={nextWord}
              className="w-full sm:w-auto rounded-lg bg-blue-600 px-6 py-2 text-white hover:bg-blue-500"
            >
              {t("nextWord")}
            </button>
            <button
              disabled={removing}
              onClick={handleRemove}
              className="w-full sm:w-auto rounded-lg bg-amber-600 px-6 py-2 text-white hover:bg-amber-500 disabled:opacity-50"
            >
              {t("removeFlag")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
