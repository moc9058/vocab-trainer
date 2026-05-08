import { useState, useMemo, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP, urlLanguageToIsoCode } from "../settings/defaults";
import { smartAddWord, lookupWord } from "../api/vocab";
import { displayTranslation, type Word } from "../types";

interface Prefill {
  term: string;
  language: string;
  example?: { sentence: string; translation: string };
}

type SmartAddPayload = {
  term: string;
  transliteration?: string;
  definitions?: { partOfSpeech: string; text: Record<string, string> }[];
  topics?: string[];
  examples?: { sentence: string; translation: string }[];
  level?: string;
  flag?: boolean;
};

interface Props {
  onSave: (word: Word) => void;
  onClose: () => void;
  prefill?: Prefill;
  defaultLanguage?: string;
  onJumpToWord?: (wordId: string, term: string) => void;
  onQueue?: (term: string, language: string, payload: SmartAddPayload) => void;
}

// LANG_OPTIONS is now derived from settings in the component

const CATEGORIES = [
  "noun", "verb", "adjective", "adverb", "preposition", "conjunction",
  "particle", "numeral", "classifier", "determiner", "pronoun",
  "interjection", "idiom", "set phrase", "phrasal verb", "collocation",
  "proverb", "greeting",
] as const;

const LEVEL_OPTIONS: Record<string, string[]> = {
  chinese: ["HSK1-4", "HSK5", "HSK6", "HSK7-9", "Advanced"],
  japanese: ["JLPT5", "JLPT4", "JLPT3", "JLPT2", "JLPT1", "Advanced"],
};

const ALL_TOPICS = [
  "Greetings & Introductions", "Food & Dining", "Shopping & Money",
  "Travel & Transportation", "Weather & Seasons", "Family & Relationships",
  "Health & Body", "Home & Housing", "Economics & Finance",
  "Politics & Government", "Science & Technology", "Law & Justice",
  "Medicine", "Education", "Business & Commerce",
  "Work & Career", "Nature & Environment",
  "Arts & Entertainment", "Sports & Fitness", "Religion & Philosophy",
  "History", "Media & News", "Language Fundamentals",
] as const;

export default function SmartAddWordModal({ onSave, onClose, prefill, defaultLanguage, onJumpToWord, onQueue }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const LANG_OPTIONS = useMemo(
    () => settings.languageOrder.map((c) => ({ value: c, label: LANG_LABEL_MAP[c] ?? c })),
    [settings.languageOrder],
  );
  const wordLanguage = prefill?.language || defaultLanguage || "english";
  const currentIsoCode = urlLanguageToIsoCode(wordLanguage) ?? "";
  const [term, setTerm] = useState(prefill?.term ?? "");
  const [transliteration, setTransliteration] = useState("");
  const [definitions, setDefinitions] = useState<{ langSelect: string; text: string }[]>(() => {
    const langSelect = settings.languageOrder[0] ?? "en";
    return [{ langSelect, text: "" }];
  });
  const [grammaticalCategory, setGrammaticalCategory] = useState("");
  const [level, setLevel] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [examples, setExamples] = useState<{ sentence: string; translation: string }[]>(
    prefill?.example ? [prefill.example] : [{ sentence: "", translation: "" }],
  );
  const [flagForReview, setFlagForReview] = useState(true);
  const [checking, setChecking] = useState(false);
  const [existingWord, setExistingWord] = useState<{ id: string; level: string; transliteration: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [generatedWords, setGeneratedWords] = useState<Word[]>([]);

  useEffect(() => {
    const trimmed = term.trim();
    if (!trimmed) {
      setExistingWord(null);
      return;
    }
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const result = await lookupWord(wordLanguage, trimmed);
        setExistingWord(result ? { id: result.id, level: result.level, transliteration: result.transliteration } : null);
      } catch {
        setExistingWord(null);
      } finally {
        setChecking(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [term, wordLanguage]);

  function getDefLangKey(def: { langSelect: string }): string {
    return def.langSelect;
  }

  function buildPayload() {
    const defObj: Record<string, string> = {};
    for (const d of definitions) {
      const key = getDefLangKey(d);
      if (key && d.text.trim()) defObj[key] = d.text.trim();
    }
    const defs = Object.keys(defObj).length > 0 || grammaticalCategory
      ? [{ partOfSpeech: grammaticalCategory || "", text: defObj }]
      : undefined;
    const validExamples = examples.filter((ex) => ex.sentence.trim());
    return {
      term: term.trim(),
      transliteration: wordLanguage === "chinese" ? (transliteration.trim() || undefined) : undefined,
      definitions: defs,
      topics: topics.length > 0 ? topics : undefined,
      examples: validExamples.length > 0 ? validExamples : undefined,
      level: level || undefined,
      flag: flagForReview,
    };
  }

  function resetForm() {
    setTerm("");
    setTransliteration("");
    const langSelect = settings.languageOrder[0] ?? "en";
    setDefinitions([{ langSelect, text: "" }]);
    setGrammaticalCategory("");
    setLevel("");
    setTopics([]);
    setExamples([{ sentence: "", translation: "" }]);
    setExistingWord(null);
    setError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim() || saving || queued) return;

    const language = wordLanguage;
    if (!language) return;

    const payload = buildPayload();

    // Queue mode: enqueue immediately and reset form for next word
    if (onQueue) {
      onQueue(term.trim(), language, payload);
      setQueued(true);
      setTimeout(() => {
        setQueued(false);
        resetForm();
      }, 900);
      return;
    }

    setSaving(true);
    setError("");
    setSuccess(false);

    try {
      const result = await smartAddWord(language, payload);
      const { generatedWords: gw, ...word } = result;
      setSuccess(true);
      setGeneratedWords(gw ?? []);
      onSave(word);
      if (!gw || gw.length === 0) {
        setTimeout(() => onClose(), 1000);
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("409")) {
        setError(t("wordAlreadyExists"));
      } else {
        setError(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-gray-800 p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-gray-100">{t("smartAddWord")}</h2>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        {success && <p className="mb-3 text-sm text-green-400">{t("wordAddedSuccess")}</p>}
        {generatedWords.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-700 bg-amber-900/30 p-3">
            <p className="mb-2 text-sm font-medium text-amber-300">
              {generatedWords.length} word{generatedWords.length > 1 ? "s" : ""} auto-generated from examples:
            </p>
            <ul className="space-y-1">
              {generatedWords.map((w) => (
                <li key={w.id} className="text-sm text-gray-300">
                  <span className="font-medium text-gray-100">{w.term}</span>
                  {w.transliteration && (
                    <span className="ml-1 text-gray-400">({w.transliteration})</span>
                  )}
                  <span className="ml-1 text-gray-500">— {w.definitions.map((m) => Object.entries(m.text || {}).filter(([lang]) => lang !== currentIsoCode).map(([, v]) => v).join("; ")).join(" | ")}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onClose}
              className="mt-3 rounded-lg bg-gray-700 px-4 py-1.5 text-sm text-gray-200 hover:bg-gray-600"
            >
              OK
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Term (required) */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("term")} *</label>
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              required
              autoFocus
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            />
            {checking && (
              <p className="mt-1 text-xs text-gray-400">Checking…</p>
            )}
            {!checking && existingWord && (
              <p className="mt-1 text-xs text-amber-400 flex items-center gap-1 flex-wrap">
                <span>
                  ⚠ Already in DB
                  {existingWord.transliteration && ` · ${existingWord.transliteration}`}
                  {existingWord.level && ` · ${existingWord.level}`}
                </span>
                {onJumpToWord && (
                  <button
                    type="button"
                    onClick={() => { onJumpToWord(existingWord.id, term.trim()); onClose(); }}
                    className="underline hover:text-amber-300 cursor-pointer"
                  >
                    Jump to word →
                  </button>
                )}
              </p>
            )}
          </div>

          {/* Transliteration (optional, Chinese only) */}
          {wordLanguage === "chinese" && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("transliteration")}</label>
              <input
                type="text"
                value={transliteration}
                onChange={(e) => setTransliteration(e.target.value)}
                placeholder="LLM will generate if empty"
                className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
              />
            </div>
          )}

          {/* Definitions (optional) */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm text-gray-400">{t("definition")}</label>
              <button
                type="button"
                onClick={() => setDefinitions([...definitions, { langSelect: "", text: "" }])}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                + {t("addDefinition")}
              </button>
            </div>
            {definitions.map((def, i) => (
              <div key={i} className="mb-2 flex gap-2">
                <select
                  value={def.langSelect}
                  onChange={(e) => {
                    const next = [...definitions];
                    next[i] = { ...next[i], langSelect: e.target.value };
                    setDefinitions(next);
                  }}
                  className="w-28 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                >
                  <option value="">--</option>
                  {LANG_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={def.text}
                  onChange={(e) => {
                    const next = [...definitions];
                    next[i] = { ...next[i], text: e.target.value };
                    setDefinitions(next);
                  }}
                  placeholder="LLM will generate if empty"
                  className="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
                />
                {definitions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setDefinitions(definitions.filter((_, j) => j !== i))}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    {t("removeDefinition")}
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Grammatical Category (optional) */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("category")}</label>
            <select
              value={grammaticalCategory}
              onChange={(e) => setGrammaticalCategory(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            >
              <option value="">-- LLM will generate --</option>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          {/* Level (optional, non-English languages with defined levels) */}
          {LEVEL_OPTIONS[wordLanguage] && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("levelsColumn")}</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                <option value="">-- LLM will assign --</option>
                {LEVEL_OPTIONS[wordLanguage].map((lv) => (
                  <option key={lv} value={lv}>{lv}</option>
                ))}
              </select>
            </div>
          )}

          {/* Topics (optional, multi-select) */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("topic")}</label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_TOPICS.map((topic) => {
                const selected = topics.includes(topic);
                return (
                  <button
                    key={topic}
                    type="button"
                    onClick={() => setTopics(selected ? topics.filter((t) => t !== topic) : [...topics, topic])}
                    className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                      selected
                        ? "bg-blue-600 text-white"
                        : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                    }`}
                  >
                    {topic}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-gray-500">LLM will generate if none selected</p>
          </div>

          {/* Examples (optional) */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm text-gray-400">{t("examples")}</label>
              <button
                type="button"
                onClick={() => setExamples([...examples, { sentence: "", translation: "" }])}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                + {t("addExample")}
              </button>
            </div>
            {examples.map((ex, i) => (
              <div key={i} className="mb-2 rounded-lg border border-gray-600 bg-gray-700 p-2 space-y-1">
                <textarea
                  ref={(el) => {
                    if (el) {
                      el.style.height = "auto";
                      el.style.height = el.scrollHeight + "px";
                    }
                  }}
                  value={ex.sentence}
                  onChange={(e) => {
                    const next = [...examples];
                    next[i] = { ...next[i], sentence: e.target.value };
                    setExamples(next);
                  }}
                  rows={1}
                  placeholder={t("sentence")}
                  className="w-full resize-none overflow-hidden rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
                <div className="flex gap-2">
                  {wordLanguage !== "english" && (
                    <input
                      type="text"
                      value={displayTranslation(ex.translation)}
                      onChange={(e) => {
                        const next = [...examples];
                        next[i] = { ...next[i], translation: e.target.value };
                        setExamples(next);
                      }}
                      placeholder={t("translationLabel")}
                      className="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                    />
                  )}
                  {examples.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setExamples(examples.filter((_, j) => j !== i))}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      {t("removeExample")}
                    </button>
                  )}
                </div>
              </div>
            ))}
            <p className="text-xs text-gray-500">LLM will generate if empty</p>
          </div>

          {/* Flag for review */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={flagForReview}
              onChange={(e) => setFlagForReview(e.target.checked)}
              className="accent-amber-500"
            />
            <span className="text-sm text-gray-300">{t("flagForReview")}</span>
          </label>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={saving || queued || !term.trim()}
              className={`rounded-lg px-4 py-2 text-sm text-white disabled:opacity-50 ${queued ? "bg-green-600 hover:bg-green-500" : "bg-blue-600 hover:bg-blue-500"}`}
            >
              {saving ? t("addingWord") : queued ? "✓ Queued" : t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
