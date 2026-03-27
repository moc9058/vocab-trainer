import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { getFilters } from "../api/vocab";
import { displayTranslation, type Word } from "../types";

interface Props {
  language: string;
  word?: Word;
  onSave: (word: Omit<Word, "id"> & { id?: string }) => Promise<void>;
  onClose: () => void;
}

export default function WordFormModal({ language, word, onSave, onClose }: Props) {
  const { t } = useI18n();
  const [term, setTerm] = useState(word?.term ?? "");
  const [transliteration, setTransliteration] = useState(word?.transliteration ?? "");
  const [definitions, setDefinitions] = useState<{ lang: string; text: string }[]>(() => {
    if (word?.definition) {
      return Object.entries(word.definition).map(([lang, text]) => ({ lang, text }));
    }
    return [{ lang: "en", text: "" }];
  });
  const [grammaticalCategory, setGrammaticalCategory] = useState(word?.grammaticalCategory ?? "");
  const [topics, setTopics] = useState<Set<string>>(new Set(word?.topics ?? []));
  const [level, setLevel] = useState(word?.level ?? "");
  const [examples, setExamples] = useState<{ sentence: string; translation: string }[]>(
    word?.examples?.map((e) => ({ sentence: e.sentence, translation: e.translation })) ?? []
  );
  const [notes, setNotes] = useState(word?.notes ?? "");
  const [availableTopics, setAvailableTopics] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getFilters(language)
      .then((f) => setAvailableTopics(f.topics))
      .catch(() => {});
  }, [language]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim() || !grammaticalCategory.trim()) return;
    const defObj: Record<string, string> = {};
    for (const d of definitions) {
      if (d.lang.trim() && d.text.trim()) defObj[d.lang.trim()] = d.text.trim();
    }
    if (Object.keys(defObj).length === 0) return;

    setSaving(true);
    setError("");
    try {
      await onSave({
        ...(word ? { id: word.id } : {}),
        term: term.trim(),
        transliteration: transliteration.trim() || undefined,
        definition: defObj,
        grammaticalCategory: grammaticalCategory.trim(),
        topics: [...topics],
        level: level.trim() || undefined,
        examples: examples.filter((ex) => ex.sentence.trim()),
        notes: notes.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(String(err));
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
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {word ? t("editWord") : t("addWord")}
        </h2>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Term */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("term")} *</label>
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Transliteration */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("transliteration")}</label>
            <input
              type="text"
              value={transliteration}
              onChange={(e) => setTransliteration(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Definitions */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm text-gray-400">{t("definition")} *</label>
              <button
                type="button"
                onClick={() => setDefinitions([...definitions, { lang: "", text: "" }])}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                + {t("addDefinition")}
              </button>
            </div>
            {definitions.map((def, i) => (
              <div key={i} className="mb-2 flex gap-2">
                <input
                  type="text"
                  value={def.lang}
                  onChange={(e) => {
                    const next = [...definitions];
                    next[i] = { ...next[i], lang: e.target.value };
                    setDefinitions(next);
                  }}
                  placeholder={t("definitionLanguage")}
                  className="w-28 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
                <input
                  type="text"
                  value={def.text}
                  onChange={(e) => {
                    const next = [...definitions];
                    next[i] = { ...next[i], text: e.target.value };
                    setDefinitions(next);
                  }}
                  placeholder={t("definitionText")}
                  className="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
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

          {/* Grammatical Category */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("category")} *</label>
            <input
              type="text"
              value={grammaticalCategory}
              onChange={(e) => setGrammaticalCategory(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Level */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("level")}</label>
            <input
              type="text"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Topics */}
          {availableTopics.length > 0 && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("topic")}</label>
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-600 bg-gray-700 p-2">
                {availableTopics.map((tp) => (
                  <button
                    key={tp}
                    type="button"
                    onClick={() => {
                      const next = new Set(topics);
                      if (next.has(tp)) next.delete(tp);
                      else next.add(tp);
                      setTopics(next);
                    }}
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      topics.has(tp)
                        ? "bg-blue-600 text-white"
                        : "bg-gray-600 text-gray-300 hover:bg-gray-500"
                    }`}
                  >
                    {tp}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Examples */}
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
              <div key={i} className="mb-2 rounded-lg border border-gray-600 bg-gray-700 p-2">
                <input
                  type="text"
                  value={ex.sentence}
                  onChange={(e) => {
                    const next = [...examples];
                    next[i] = { ...next[i], sentence: e.target.value };
                    setExamples(next);
                  }}
                  placeholder={t("sentence")}
                  className="mb-1 w-full rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
                <div className="flex gap-2">
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
                  <button
                    type="button"
                    onClick={() => setExamples(examples.filter((_, j) => j !== i))}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    {t("removeExample")}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Notes */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("notes")}</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={saving || !term.trim() || !grammaticalCategory.trim() || !definitions.some(d => d.lang.trim() && d.text.trim())}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? "..." : t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
