import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { getGrammarChapters, getSubchapters, createGrammarItem } from "../api/grammar";
import type { GrammarChapterInfo } from "../types";

const GRAMMAR_LANG_OPTIONS = [
  { value: "chinese", label: "Chinese" },
  { value: "english", label: "English" },
  { value: "__other__", label: "Other" },
] as const;

interface Props {
  language?: string;
  onSave: () => void;
  onClose: () => void;
}

export default function GrammarFormModal({ language: initialLanguage, onSave, onClose }: Props) {
  const { t } = useI18n();
  const [langSelect, setLangSelect] = useState(
    initialLanguage === "chinese" || initialLanguage === "english"
      ? initialLanguage
      : initialLanguage
        ? "__other__"
        : "chinese"
  );
  const [customLang, setCustomLang] = useState(
    initialLanguage && initialLanguage !== "chinese" && initialLanguage !== "english"
      ? initialLanguage
      : ""
  );
  const language =
    langSelect === "__other__" ? customLang.trim().toLowerCase() : langSelect;
  const [chapters, setChapters] = useState<GrammarChapterInfo[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
  const [subchapters, setSubchapters] = useState<{ subchapterId: string; subchapterTitle: Record<string, string> }[]>([]);
  const [selectedSubchapter, setSelectedSubchapter] = useState("");
  const [newSubchapterName, setNewSubchapterName] = useState("");
  const [inputLang, setInputLang] = useState("ja");
  const [termText, setTermText] = useState("");
  const [descText, setDescText] = useState("");
  const [wordsText, setWordsText] = useState("");
  const [examples, setExamples] = useState<{ sentence: string; translation: string }[]>([]);
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getGrammarChapters(language)
      .then(setChapters)
      .catch(() => setChapters([]));
  }, [language]);

  useEffect(() => {
    if (selectedChapter != null) {
      getSubchapters(language, [selectedChapter])
        .then((subs) => setSubchapters(subs.map((s) => ({ subchapterId: s.subchapterId, subchapterTitle: s.subchapterTitle }))))
        .catch(() => setSubchapters([]));
    }
  }, [language, selectedChapter]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedChapter == null || !termText.trim()) return;

    const isNewSubchapter = selectedSubchapter === "__new__";
    const subId = isNewSubchapter
      ? `${selectedChapter}-${Date.now()}`
      : selectedSubchapter;
    const subTitle = isNewSubchapter
      ? { [inputLang]: newSubchapterName.trim() }
      : subchapters.find((s) => s.subchapterId === selectedSubchapter)?.subchapterTitle || {};
    if (isNewSubchapter && !newSubchapterName.trim()) return;
    if (!isNewSubchapter && !subId) return;

    setSaving(true);
    setError("");

    const componentId = `grammar-zh-${String(selectedChapter).padStart(3, "0")}-${Date.now()}`;

    try {
      const filteredExamples = examples
        .filter((ex) => ex.sentence.trim())
        .map((ex) => ({
          sentence: ex.sentence.trim(),
          translation: ex.translation.trim(),
        }));
      const wordsArr = wordsText.trim()
        ? wordsText.split(",").map((w) => w.trim()).filter(Boolean)
        : undefined;

      await createGrammarItem(language, {
        id: componentId,
        chapterNumber: selectedChapter,
        subchapterId: subId,
        subchapterTitle: subTitle,
        term: { [inputLang]: termText.trim() },
        ...(descText.trim() ? { description: { [inputLang]: descText.trim() } } : {}),
        ...(filteredExamples.length > 0 ? { examples: filteredExamples } : {}),
        ...(wordsArr ? { words: wordsArr } : {}),
        tags: tags.trim() ? tags.split(",").map((t) => t.trim()) : undefined,
      });
      onSave();
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
        <h2 className="mb-4 text-lg font-semibold text-gray-100">{t("addGrammar")}</h2>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Grammar Language */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">Language</label>
            <div className="flex items-center gap-3">
              {GRAMMAR_LANG_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="radio"
                    name="grammarLang"
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
                  placeholder="e.g. french"
                  className="rounded border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
              )}
            </div>
          </div>

          {/* Input Language Selector */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("displayLanguage")}</label>
            <div className="flex gap-3">
              {[
                { value: "ja", label: "JA" },
                { value: "en", label: "EN" },
                { value: "kr", label: "KR" },
              ].map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="radio"
                    name="inputLang"
                    value={opt.value}
                    checked={inputLang === opt.value}
                    onChange={() => setInputLang(opt.value)}
                    className="accent-blue-600"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          {/* Chapter */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("chapterLabel")} *</label>
            <select
              value={selectedChapter ?? ""}
              onChange={(e) => { setSelectedChapter(e.target.value ? Number(e.target.value) : null); setSelectedSubchapter(""); }}
              required
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            >
              <option value="">--</option>
              {chapters.map((ch) => (
                <option key={ch.chapterNumber} value={ch.chapterNumber}>
                  {ch.chapterTitle[inputLang] || ch.chapterTitle.en || ch.chapterTitle.ja}
                </option>
              ))}
            </select>
          </div>

          {/* Subchapter */}
          {selectedChapter != null && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("subchapterLabel")} *</label>
              <select
                value={selectedSubchapter}
                onChange={(e) => setSelectedSubchapter(e.target.value)}
                className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                <option value="">--</option>
                {subchapters.map((s) => (
                  <option key={s.subchapterId} value={s.subchapterId}>
                    {s.subchapterTitle[inputLang] || s.subchapterTitle.en || s.subchapterTitle.ja || s.subchapterId}
                  </option>
                ))}
                <option value="__new__">+ {t("newSubchapter")}</option>
              </select>
              {selectedSubchapter === "__new__" && (
                <div className="mt-2">
                  <input
                    type="text"
                    value={newSubchapterName}
                    onChange={(e) => setNewSubchapterName(e.target.value)}
                    placeholder={`Subchapter name (${inputLang.toUpperCase()})`}
                    className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                  />
                </div>
              )}
            </div>
          )}

          {/* Term */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("grammarTerm")} *</label>
            <input
              type="text"
              value={termText}
              onChange={(e) => setTermText(e.target.value)}
              placeholder="e.g. 别+V+了, (V or Adj)+地"
              required
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("grammarDescription")}</label>
            <textarea
              value={descText}
              onChange={(e) => setDescText(e.target.value)}
              placeholder={`${inputLang.toUpperCase()}`}
              rows={3}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Related Words */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("relatedWords")}</label>
            <input
              type="text"
              value={wordsText}
              onChange={(e) => setWordsText(e.target.value)}
              placeholder="别, 吃, 去"
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Examples */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm text-gray-400">{t("examples")}</label>
              <button type="button" onClick={() => setExamples([...examples, { sentence: "", translation: "" }])} className="text-xs text-blue-400 hover:text-blue-300">
                + {t("addExample")}
              </button>
            </div>
            {examples.map((ex, i) => (
              <div key={i} className="mb-2 rounded-lg border border-gray-600 bg-gray-700 p-2 space-y-1">
                <input type="text" value={ex.sentence} onChange={(e) => { const n = [...examples]; n[i] = { ...n[i], sentence: e.target.value }; setExamples(n); }} placeholder={t("sentence")} className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none" />
                <div className="flex gap-2">
                  <input type="text" value={ex.translation} onChange={(e) => { const n = [...examples]; n[i] = { ...n[i], translation: e.target.value }; setExamples(n); }} placeholder={t("translationLabel")} className="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none" />
                  <button type="button" onClick={() => setExamples(examples.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-300">{t("removeExample")}</button>
                </div>
              </div>
            ))}
          </div>

          {/* Tags */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">Tags</label>
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated,tags" className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none" />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700">{t("cancel")}</button>
            <button type="submit" disabled={saving || selectedChapter == null || !termText.trim()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50">
              {saving ? "..." : t("save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
