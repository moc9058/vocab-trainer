import { useState } from "react";
import { useI18n } from "../i18n/context";
import { smartAddWord } from "../api/vocab";
import type { Word } from "../types";

interface Props {
  language: string;
  onSave: (word: Word) => void;
  onClose: () => void;
}

export default function SmartAddWordModal({ language, onSave, onClose }: Props) {
  const { t } = useI18n();
  const [term, setTerm] = useState("");
  const [transliteration, setTransliteration] = useState("");
  const [definitions, setDefinitions] = useState<{ lang: string; text: string }[]>([
    { lang: "", text: "" },
  ]);
  const [grammaticalCategory, setGrammaticalCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim() || saving) return;

    setSaving(true);
    setError("");
    setSuccess(false);

    const defObj: Record<string, string> = {};
    for (const d of definitions) {
      if (d.lang.trim() && d.text.trim()) defObj[d.lang.trim()] = d.text.trim();
    }

    try {
      const word = await smartAddWord(language, {
        term: term.trim(),
        transliteration: transliteration.trim() || undefined,
        definition: Object.keys(defObj).length > 0 ? defObj : undefined,
        grammaticalCategory: grammaticalCategory.trim() || undefined,
        notes: notes.trim() || undefined,
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

          {/* Transliteration (optional) */}
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

          {/* Definitions (optional) */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm text-gray-400">{t("definition")}</label>
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
            <input
              type="text"
              value={grammaticalCategory}
              onChange={(e) => setGrammaticalCategory(e.target.value)}
              placeholder="LLM will generate if empty"
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Notes (optional) */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("notes")}</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="LLM will generate if empty"
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
            />
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
