import { useState } from "react";
import { useI18n } from "../i18n/context";
import { smartAddWord } from "../api/vocab";
import type { Word } from "../types";

interface Props {
  onSave: (word: Word) => void;
  onClose: () => void;
}

const WORD_LANG_OPTIONS = [
  { value: "chinese", label: "Chinese" },
  { value: "english", label: "English" },
  { value: "__other__", label: "Other" },
] as const;

const LANG_OPTIONS = [
  { value: "Japanese", label: "Japanese" },
  { value: "English", label: "English" },
  { value: "Korean", label: "Korean" },
  { value: "__other__", label: "Other" },
] as const;

const CATEGORIES = [
  "noun", "verb", "adjective", "adverb", "preposition", "conjunction",
  "particle", "numeral", "classifier", "determiner", "pronoun",
  "interjection", "idiom", "phrase",
] as const;

const ALL_TOPICS = [
  "Greetings & Introductions", "Food & Dining", "Shopping & Money",
  "Travel & Transportation", "Weather & Seasons", "Family & Relationships",
  "Health & Body", "Home & Housing", "Economics & Finance",
  "Politics & Government", "Science & Technology", "Law & Justice",
  "Medicine", "Education", "Business & Commerce",
  "Arts & Entertainment", "Sports & Fitness", "Religion & Philosophy",
  "History", "Media & News", "Language Fundamentals",
] as const;

export default function SmartAddWordModal({ onSave, onClose }: Props) {
  const { t } = useI18n();
  const [langSelect, setLangSelect] = useState("chinese");
  const [customLang, setCustomLang] = useState("");
  const [term, setTerm] = useState("");
  const [transliteration, setTransliteration] = useState("");
  const [definitions, setDefinitions] = useState<{ langSelect: string; customLang: string; text: string }[]>([
    { langSelect: "", customLang: "", text: "" },
  ]);
  const [grammaticalCategory, setGrammaticalCategory] = useState("");
  const [topics, setTopics] = useState<string[]>([]);
  const [examples, setExamples] = useState<{ sentence: string; translation: string }[]>([
    { sentence: "", translation: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

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

    const validExamples = examples.filter((ex) => ex.sentence.trim());
    const language = langSelect === "__other__" ? customLang.trim().toLowerCase() : langSelect;
    if (!language) return;

    try {
      const word = await smartAddWord(language, {
        term: term.trim(),
        transliteration: langSelect === "chinese" ? (transliteration.trim() || undefined) : undefined,
        definition: Object.keys(defObj).length > 0 ? defObj : undefined,
        grammaticalCategory: grammaticalCategory || undefined,
        topics: topics.length > 0 ? topics : undefined,
        examples: validExamples.length > 0 ? validExamples : undefined,
      });
      setSuccess(true);
      onSave(word);
      setTimeout(() => onClose(), 1000);
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
                <input
                  type="text"
                  value={ex.sentence}
                  onChange={(e) => {
                    const next = [...examples];
                    next[i] = { ...next[i], sentence: e.target.value };
                    setExamples(next);
                  }}
                  placeholder={t("sentence")}
                  className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={ex.translation}
                    onChange={(e) => {
                      const next = [...examples];
                      next[i] = { ...next[i], translation: e.target.value };
                      setExamples(next);
                    }}
                    placeholder={t("translationLabel")}
                    className="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                  />
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
