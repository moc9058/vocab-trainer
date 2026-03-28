import { useState, useEffect, useCallback } from "react";
import { useI18n } from "../i18n/context";
import { getFlaggedWords, unflagWord } from "../api/flagged";
import RubyText from "./RubyText";
import { displayTranslation, type Word } from "../types";

const LANG_DISPLAY: Record<string, string> = { ja: "Japanese", en: "English", ko: "Korean" };

interface Props {
  language: string;
  onBack: () => void;
  transliterationMap?: Record<string, string>;
}

function pickRandom(words: Word[], excludeId?: string): Word | null {
  const pool = excludeId ? words.filter((w) => w.id !== excludeId) : words;
  if (pool.length === 0) return words[0] ?? null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export default function FlaggedReview({ language, onBack, transliterationMap = {} }: Props) {
  const { t } = useI18n();
  const [words, setWords] = useState<Word[]>([]);
  const [currentWord, setCurrentWord] = useState<Word | null>(null);
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    getFlaggedWords(language)
      .then(({ words: flagged }) => {
        setWords(flagged);
        setCurrentWord(flagged.length > 0 ? flagged[Math.floor(Math.random() * flagged.length)] : null);
      })
      .catch(() => setWords([]))
      .finally(() => setLoading(false));
  }, [language]);

  const nextWord = useCallback(() => {
    setCurrentWord((prev) => pickRandom(words, prev?.id));
    setShowingAnswer(false);
  }, [words]);

  async function handleRemove() {
    if (!currentWord || removing) return;
    setRemoving(true);
    try {
      await unflagWord(language, currentWord.id);
      const remaining = words.filter((w) => w.id !== currentWord.id);
      setWords(remaining);
      setCurrentWord(remaining.length > 0 ? remaining[Math.floor(Math.random() * remaining.length)] : null);
      setShowingAnswer(false);
    } finally {
      setRemoving(false);
    }
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
        <button
          onClick={onBack}
          className="rounded-lg border border-gray-600 px-6 py-2 text-gray-300 hover:bg-gray-700"
        >
          {t("back")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <p className="text-sm text-gray-400">
        {words.length} {t("flaggedWords").toLowerCase()}
      </p>
      <h2 className="text-xl sm:text-3xl font-bold text-gray-100">{currentWord!.term}</h2>

      {!showingAnswer ? (
        <button
          onClick={() => setShowingAnswer(true)}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showAnswer")}
        </button>
      ) : (
        <>
          <div className="text-center space-y-2">
            {(currentWord!.definitions ?? []).map((m, mi) => (
              <div key={mi}>
                {m.partOfSpeech && <p className="text-xs text-gray-500 italic">{m.partOfSpeech}</p>}
                {Object.entries(m.text || {}).map(([lang, text]) => (
                  <p key={lang} className="text-xl text-green-400">
                    <span className="text-sm text-gray-400">{LANG_DISPLAY[lang] || lang}: </span>{text}
                  </p>
                ))}
              </div>
            ))}
          </div>

          {currentWord!.transliteration && (
            <p className="text-xl text-gray-400">{currentWord!.transliteration}</p>
          )}

          {currentWord!.examples && currentWord!.examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
              {currentWord!.examples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100">
                    <RubyText text={ex.sentence} transliterationMap={transliterationMap} segments={ex.segments} />
                  </p>
                  <p className="text-sm text-gray-400">{displayTranslation(ex.translation)}</p>
                </div>
              ))}
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
