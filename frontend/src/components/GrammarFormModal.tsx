import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import { getGrammarChapters, getSubchapters, createGrammarItem, updateGrammarItem } from "../api/grammar";
import { displayTranslation, type GrammarChapterInfo, type GrammarItemDoc } from "../types";

const GRAMMAR_LANG_OPTIONS = [
  { value: "english", label: "English" },
  { value: "chinese", label: "Chinese" },
  { value: "__other__", label: "Other" },
] as const;

interface Props {
  language?: string;
  editItem?: GrammarItemDoc;
  onSave: () => void;
  onClose: () => void;
}

function detectLangSelect(lang: string) {
  if (lang === "chinese" || lang === "english") return lang;
  return lang ? "__other__" : "chinese";
}

function InsertButton({ onInsert }: { onInsert: () => void }) {
  return (
    <div className="group relative flex h-3 items-center justify-center">
      <div className="absolute inset-x-0 top-1/2 h-px bg-gray-600 opacity-0 transition-opacity group-hover:opacity-100" />
      <button
        type="button"
        onClick={onInsert}
        className="relative z-10 flex h-5 w-5 items-center justify-center rounded-full bg-gray-600 text-xs text-gray-300 opacity-0 transition-opacity hover:bg-blue-600 hover:text-white group-hover:opacity-100"
      >
        +
      </button>
    </div>
  );
}

export default function GrammarFormModal({ language: initialLanguage, editItem, onSave, onClose }: Props) {
  const { t } = useI18n();
  const isEdit = !!editItem;
  const effectiveLang = editItem?.language ?? initialLanguage;

  const [langSelect, setLangSelect] = useState(detectLangSelect(effectiveLang ?? ""));
  const [customLang, setCustomLang] = useState(
    effectiveLang && effectiveLang !== "chinese" && effectiveLang !== "english"
      ? effectiveLang
      : ""
  );
  const language =
    langSelect === "__other__" ? customLang.trim().toLowerCase() : langSelect;
  const [chapters, setChapters] = useState<GrammarChapterInfo[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<number | null>(editItem?.chapterNumber ?? null);
  const [subchapters, setSubchapters] = useState<{ subchapterId: string; subchapterTitle: Record<string, string> }[]>([]);
  const [selectedSubchapter, setSelectedSubchapter] = useState(editItem?.subchapterId ?? "");
  const [newSubchapterName, setNewSubchapterName] = useState("");

  // Detect which input language to use from existing term keys
  const defaultInputLang = editItem
    ? (Object.keys(editItem.term).find((k) => ["ja", "en", "ko"].includes(k)) ?? "ja")
    : "ja";
  const [inputLang, setInputLang] = useState(defaultInputLang);

  const [termText, setTermText] = useState(editItem ? (editItem.term[defaultInputLang] ?? Object.values(editItem.term)[0] ?? "") : "");
  const [descText, setDescText] = useState(
    editItem?.description ? (editItem.description[defaultInputLang] ?? Object.values(editItem.description)[0] ?? "") : ""
  );
  const [wordsList, setWordsList] = useState<string[]>(editItem?.words ?? []);
  const [examples, setExamples] = useState<{ sentence: string; translation: string }[]>(
    editItem?.examples?.map((ex) => ({ sentence: ex.sentence, translation: ex.translation })) ?? []
  );
  const [tags, setTags] = useState(editItem?.tags?.join(", ") ?? "");
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

    try {
      const filteredExamples = examples
        .filter((ex) => ex.sentence.trim())
        .map((ex) => ({
          sentence: ex.sentence.trim(),
          translation: ex.translation.trim(),
        }));
      const wordsArr = wordsList.map((w) => w.trim()).filter(Boolean);
      const wordsPayload = wordsArr.length > 0 ? wordsArr : undefined;

      const termValue = isEdit && editItem
        ? { ...editItem.term, [inputLang]: termText.trim() }
        : { [inputLang]: termText.trim() };
      const descValue = isEdit && editItem?.description
        ? { ...editItem.description, ...(descText.trim() ? { [inputLang]: descText.trim() } : {}) }
        : descText.trim() ? { [inputLang]: descText.trim() } : undefined;

      if (isEdit && editItem) {
        await updateGrammarItem(language, editItem.id, {
          chapterNumber: selectedChapter,
          subchapterId: subId,
          subchapterTitle: subTitle,
          term: termValue,
          ...(descValue ? { description: descValue } : {}),
          ...(filteredExamples.length > 0 ? { examples: filteredExamples } : {}),
          ...(wordsPayload ? { words: wordsPayload } : {}),
          tags: tags.trim() ? tags.split(",").map((t) => t.trim()) : undefined,
        });
      } else {
        const componentId = `grammar-zh-${String(selectedChapter).padStart(3, "0")}-${Date.now()}`;
        await createGrammarItem(language, {
          id: componentId,
          chapterNumber: selectedChapter,
          subchapterId: subId,
          subchapterTitle: subTitle,
          term: termValue,
          ...(descValue ? { description: descValue } : {}),
          ...(filteredExamples.length > 0 ? { examples: filteredExamples } : {}),
          ...(wordsPayload ? { words: wordsPayload } : {}),
          tags: tags.trim() ? tags.split(",").map((t) => t.trim()) : undefined,
        });
      }
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
        <h2 className="mb-4 text-lg font-semibold text-gray-100">{t(isEdit ? "editGrammar" : "addGrammar")}</h2>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Grammar Language */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">Language</label>
            <div className="flex items-center gap-3">
              {GRAMMAR_LANG_OPTIONS.map((opt) => (
                <label key={opt.value} className={`flex items-center gap-1.5 text-sm text-gray-300 ${isEdit ? "opacity-50" : "cursor-pointer"}`}>
                  <input
                    type="radio"
                    name="grammarLang"
                    value={opt.value}
                    checked={langSelect === opt.value}
                    onChange={() => setLangSelect(opt.value)}
                    disabled={isEdit}
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
                  disabled={isEdit}
                  className="rounded border border-gray-600 bg-gray-700 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none disabled:opacity-50"
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
                { value: "ko", label: "KO" },
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

          {/* Terms */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("grammarTerms")}</label>
            {wordsList.map((w, i) => (
              <div key={i}>
                <InsertButton onInsert={() => { const n = [...wordsList]; n.splice(i, 0, ""); setWordsList(n); }} />
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={w}
                    onChange={(e) => { const n = [...wordsList]; n[i] = e.target.value; setWordsList(n); }}
                    placeholder="e.g. 别+V+了"
                    className="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
                  />
                  <button type="button" onClick={() => setWordsList(wordsList.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-300">
                    {t("removeExample")}
                  </button>
                </div>
              </div>
            ))}
            <InsertButton onInsert={() => setWordsList([...wordsList, ""])} />
          </div>

          {/* Examples */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("examples")}</label>
            {examples.map((ex, i) => (
              <div key={i}>
                <InsertButton onInsert={() => { const n = [...examples]; n.splice(i, 0, { sentence: "", translation: "" }); setExamples(n); }} />
                <div className="rounded-lg border border-gray-600 bg-gray-700 p-2 space-y-1">
                  <input type="text" value={ex.sentence} onChange={(e) => { const n = [...examples]; n[i] = { ...n[i], sentence: e.target.value }; setExamples(n); }} placeholder={t("sentence")} className="w-full rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none" />
                  <div className="flex gap-2">
                    <input type="text" value={displayTranslation(ex.translation)} onChange={(e) => { const n = [...examples]; n[i] = { ...n[i], translation: e.target.value }; setExamples(n); }} placeholder={t("translationLabel")} className="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none" />
                    <button type="button" onClick={() => setExamples(examples.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-300">{t("removeExample")}</button>
                  </div>
                </div>
              </div>
            ))}
            <InsertButton onInsert={() => setExamples([...examples, { sentence: "", translation: "" }])} />
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
