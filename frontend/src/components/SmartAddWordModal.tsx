import { useState, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP } from "../settings/defaults";
import { smartAddWord } from "../api/vocab";
import { displayTranslation, type Word } from "../types";

interface Prefill {
  term: string;
  language: string;
  example?: { sentence: string; translation: string };
}

interface Props {
  onSave: (word: Word) => void;
  onClose: () => void;
  prefill?: Prefill;
}

const WORD_LANG_OPTIONS = [
  { value: "english", label: "English" },
  { value: "chinese", label: "Chinese" },
  { value: "__other__", label: "Other" },
] as const;

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

export default function SmartAddWordModal({ onSave, onClose, prefill }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const LANG_OPTIONS = useMemo(
    () => [
      ...settings.languageOrder.map((c) => ({ value: c, label: LANG_LABEL_MAP[c] ?? c })),
      { value: "__other__", label: "Other" },
    ],
    [settings.languageOrder],
  );
  const prefillLang = prefill?.language ?? "";
  const isKnownLang = WORD_LANG_OPTIONS.some((o) => o.value === prefillLang);
  const [langSelect, setLangSelect] = useState(prefill ? (isKnownLang ? prefillLang : "__other__") : "english");
  const [customLang, setCustomLang] = useState(prefill && !isKnownLang ? prefillLang : "");
  const [term, setTerm] = useState(prefill?.term ?? "");
  const [transliteration, setTransliteration] = useState("");
  const [definitions, setDefinitions] = useState<{ langSelect: string; customLang: string; text: string }[]>([
    { langSelect: "en", customLang: "", text: "" },
  ]);
  const [grammaticalCategory, setGrammaticalCategory] = useState("");
  const [level, setLevel] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [examples, setExamples] = useState<{ sentence: string; translation: string }[]>(
    prefill?.example ? [prefill.example] : [{ sentence: "", translation: "" }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [generatedWords, setGeneratedWords] = useState<Word[]>([]);

  function getDefLangKey(def: { langSelect: string; customLang: string }): string {
    if (def.langSelect === "__other__") return def.customLang.trim();
    return def.langSelect;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim() || saving) return;

    setSaving(true);
    setError("");
    setSuccess(false);

    const defObj: Record<string, string> = {};
    for (const d of definitions) {
      const key = getDefLangKey(d);
      if (key && d.text.trim()) defObj[key] = d.text.trim();
    }

    // Bundle user-provided definition hints + category into a definitions array
    const defs = Object.keys(defObj).length > 0 || grammaticalCategory
      ? [{ partOfSpeech: grammaticalCategory || "", text: defObj }]
      : undefined;

    const validExamples = examples.filter((ex) => ex.sentence.trim());
    const language = langSelect === "__other__" ? customLang.trim().toLowerCase() : langSelect;
    if (!language) return;

    try {
      const result = await smartAddWord(language, {
        term: term.trim(),
        transliteration: langSelect === "chinese" ? (transliteration.trim() || undefined) : undefined,
        definitions: defs,
        topics: topics.length > 0 ? topics : undefined,
        examples: validExamples.length > 0 ? validExamples : undefined,
        level: level || undefined,
        definitionLanguages: settings.defaultDefinitionLanguages,
        exampleTranslationLanguages: settings.defaultExampleTranslationLanguages,
      });
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
                  <span className="ml-1 text-gray-500">— {w.definitions.map((m) => Object.values(m.text || {}).join("; ")).join(" | ")}</span>
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
          {/* Language */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">Language</label>
            <div className="flex items-center gap-3">
              {WORD_LANG_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="radio"
                    name="wordLang"
                    value={opt.value}
                    checked={langSelect === opt.value}
                    onChange={() => setLangSelect(opt.value)}
                    className="accent-blue-600"
                  />
                  {opt.label}
                </label>
              ))}
              {langSelect === "__other__" && (
                <input
                  type="text"
                  value={customLang}
                  onChange={(e) => setCustomLang(e.target.value)}
                  placeholder="Language name"
                  className="w-32 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
              )}
            </div>
          </div>

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
          </div>

          {/* Transliteration (optional, Chinese only) */}
          {langSelect === "chinese" && (
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
                onClick={() => setDefinitions([...definitions, { langSelect: "", customLang: "", text: "" }])}
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
                    next[i] = { ...next[i], langSelect: e.target.value, customLang: "" };
                    setDefinitions(next);
                  }}
                  className="w-28 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                >
                  <option value="">--</option>
                  {LANG_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {def.langSelect === "__other__" && (
                  <input
                    type="text"
                    value={def.customLang}
                    onChange={(e) => {
                      const next = [...definitions];
                      next[i] = { ...next[i], customLang: e.target.value };
                      setDefinitions(next);
                    }}
                    placeholder="Language"
                    className="w-24 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                  />
                )}
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
          {LEVEL_OPTIONS[langSelect] && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("levelsColumn")}</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                <option value="">-- LLM will assign --</option>
                {LEVEL_OPTIONS[langSelect].map((lv) => (
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
                  {langSelect !== "english" && (
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
              disabled={saving || !term.trim()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? t("addingWord") : t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
