import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { getFilters } from "../api/vocab";
import { displayTranslation, type Word, type Meaning } from "../types";

interface MeaningFormState {
  partOfSpeech: string;
  translations: { lang: string; text: string }[];
}

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
  const [meanings, setMeanings] = useState<MeaningFormState[]>(() => {
    if (word?.definitions && word.definitions.length > 0) {
      return word.definitions.map((m) => ({
        partOfSpeech: m.partOfSpeech,
        translations: Object.entries(m.text || {}).map(([lang, text]) => ({ lang, text })),
      }));
    }
    return [{ partOfSpeech: "", translations: [{ lang: "en", text: "" }] }];
  });
  const [topics, setTopics] = useState<Set<string>>(new Set(word?.topics ?? []));
  const [level, setLevel] = useState(word?.level ?? "");
  const [examples, setExamples] = useState<{ sentence: string; translation: string }[]>(
    word?.examples?.map((e) => ({ sentence: e.sentence, translation: displayTranslation(e.translation) })) ?? []
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

  function buildDefinitions(): Meaning[] {
    const result: Meaning[] = [];
    for (const m of meanings) {
      const text: Record<string, string> = {};
      for (const tr of m.translations) {
        if (tr.lang.trim() && tr.text.trim()) text[tr.lang.trim()] = tr.text.trim();
      }
      if (Object.keys(text).length > 0) {
        result.push({ partOfSpeech: m.partOfSpeech.trim(), text });
      }
    }
    return result;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim()) return;
    const defs = buildDefinitions();
    if (defs.length === 0) return;

    setSaving(true);
    setError("");
    try {
      await onSave({
        ...(word ? { id: word.id } : {}),
        term: term.trim(),
        transliteration: transliteration.trim() || undefined,
        definitions: defs,
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

  function updateMeaning(idx: number, update: Partial<MeaningFormState>) {
    setMeanings((prev) => prev.map((m, i) => (i === idx ? { ...m, ...update } : m)));
  }

  function updateTranslation(meaningIdx: number, trIdx: number, update: Partial<{ lang: string; text: string }>) {
    setMeanings((prev) =>
      prev.map((m, i) =>
        i === meaningIdx
          ? { ...m, translations: m.translations.map((tr, j) => (j === trIdx ? { ...tr, ...update } : tr)) }
          : m
      )
    );
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

          {/* Definitions (Meanings) */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm text-gray-400">{t("definition")} *</label>
              <button
                type="button"
                onClick={() => setMeanings([...meanings, { partOfSpeech: "", translations: [{ lang: "en", text: "" }] }])}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                + {t("addDefinition")}
              </button>
            </div>
            {meanings.map((meaning, mi) => (
              <div key={mi} className="mb-3 rounded-lg border border-gray-600 bg-gray-700 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={meaning.partOfSpeech}
                    onChange={(e) => updateMeaning(mi, { partOfSpeech: e.target.value })}
                    placeholder={t("category")}
                    className="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                  />
                  {meanings.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setMeanings(meanings.filter((_, j) => j !== mi))}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      {t("removeDefinition")}
                    </button>
                  )}
                </div>
                {meaning.translations.map((tr, ti) => (
                  <div key={ti} className="mb-1 flex gap-2">
                    <input
                      type="text"
                      value={tr.lang}
                      onChange={(e) => updateTranslation(mi, ti, { lang: e.target.value })}
                      placeholder={t("definitionLanguage")}
                      className="w-20 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={tr.text}
                      onChange={(e) => updateTranslation(mi, ti, { text: e.target.value })}
                      placeholder={t("definitionText")}
                      className="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                    />
                    {meaning.translations.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          updateMeaning(mi, { translations: meaning.translations.filter((_, j) => j !== ti) })
                        }
                        className="text-xs text-red-400 hover:text-red-300 shrink-0"
                      >
                        x
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    updateMeaning(mi, { translations: [...meaning.translations, { lang: "", text: "" }] })
                  }
                  className="mt-1 text-xs text-blue-400 hover:text-blue-300"
                >
                  + {t("addDefinition")}
                </button>
              </div>
            ))}
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
              disabled={saving || !term.trim() || buildDefinitions().length === 0}
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
