import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import {
  smartAddGrammarItem,
  updateGrammarItem,
  getGrammarGroups,
  modifyGrammarGroupMembers,
} from "../api/grammar";
import { ALL_KNOWN_LANGUAGES } from "../settings/defaults";
import { LEVEL_OPTIONS } from "../constants/levels";
import ExampleSentenceEditor, { type ExampleFormState } from "./ExampleSentenceEditor";
import type { Grammar, GrammarGroup, Meaning } from "../types";

interface DescriptionFormState {
  partOfSpeech: string;
  translations: { lang: string; text: string }[];
  pinyinsRaw?: string;
}

interface Props {
  language: string;
  editItem?: Grammar;
  onSave: () => void;
  onClose: () => void;
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

export default function GrammarFormModal({ language, editItem, onSave, onClose }: Props) {
  const { t } = useI18n();
  const isEdit = !!editItem;
  const isChinese = language === "chinese";

  const [statement, setStatement] = useState(editItem?.statement ?? "");
  const [descriptions, setDescriptions] = useState<DescriptionFormState[]>(() => {
    if (editItem?.descriptions && editItem.descriptions.length > 0) {
      return editItem.descriptions.map((m) => ({
        partOfSpeech: m.partOfSpeech,
        translations: Object.entries(m.text || {}).map(([lang, text]) => ({ lang, text })),
        pinyinsRaw: m.pinyins?.join(", ") ?? "",
      }));
    }
    return [{ partOfSpeech: "", translations: [{ lang: "en", text: "" }], pinyinsRaw: "" }];
  });
  const [wordsList, setWordsList] = useState<string[]>(editItem?.words ?? []);
  const [examples, setExamples] = useState<ExampleFormState[]>(
    editItem?.examples?.map((ex) => ({
      sentence: ex.sentence,
      translation: ex.translation,
      originalTranslation: ex.translation ?? "",
      locked: false,
    })) ?? [{ sentence: "", translation: "", originalTranslation: "", locked: false }]
  );
  const [level, setLevel] = useState(editItem?.level ?? "");
  const [tags, setTags] = useState(editItem?.tags?.join(", ") ?? "");

  const [groups, setGroups] = useState<GrammarGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editItem?.id) {
      setGroups([]);
      setSelectedGroupIds(new Set());
      return;
    }
    getGrammarGroups(language)
      .then((loaded) => {
        setGroups(loaded);
        setSelectedGroupIds(
          new Set(loaded.filter((g) => g.grammarIds.includes(editItem.id)).map((g) => g.id))
        );
      })
      .catch(() => {
        setGroups([]);
        setSelectedGroupIds(new Set());
      });
  }, [language, editItem?.id]);

  function updateDescription(idx: number, update: Partial<DescriptionFormState>) {
    setDescriptions((prev) => prev.map((d, i) => (i === idx ? { ...d, ...update } : d)));
  }

  function updateTranslation(
    descIdx: number,
    trIdx: number,
    update: Partial<{ lang: string; text: string }>
  ) {
    setDescriptions((prev) =>
      prev.map((d, i) =>
        i === descIdx
          ? { ...d, translations: d.translations.map((tr, j) => (j === trIdx ? { ...tr, ...update } : tr)) }
          : d
      )
    );
  }

  function buildDescriptions(): Meaning[] {
    const result: Meaning[] = [];
    for (const d of descriptions) {
      const text: Record<string, string> = {};
      for (const tr of d.translations) {
        if (tr.lang.trim() && tr.text.trim()) text[tr.lang.trim()] = tr.text.trim();
      }
      if (Object.keys(text).length > 0) {
        const pinyins = d.pinyinsRaw
          ? d.pinyinsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        result.push({
          partOfSpeech: d.partOfSpeech.trim(),
          text,
          ...(pinyins?.length ? { pinyins } : {}),
        });
      }
    }
    return result;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!statement.trim()) return;
    const descs = buildDescriptions();
    if (descs.length === 0) {
      setError("At least one description with text is required.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const filteredExamples = examples
        .filter((ex) => ex.sentence.trim())
        .map((ex) => {
          const trimmed = ex.sentence.trim();
          if (isChinese) {
            const sentence = trimmed.replace(/[\s　]+/g, "");
            if (/[\s　]/.test(trimmed)) {
              const splits = trimmed.match(/[\p{Script=Han}a-zA-Z]+/gu) ?? [];
              if (splits.length >= 2) {
                return { sentence, translation: ex.translation.trim(), userSplits: splits };
              }
            }
            return { sentence, translation: ex.translation.trim() };
          }
          return { sentence: trimmed, translation: ex.translation.trim() };
        });
      const wordsArr = wordsList.map((w) => w.trim()).filter(Boolean);
      const tagsArr = tags.trim() ? tags.split(",").map((s) => s.trim()).filter(Boolean) : [];

      let saved: Grammar;
      if (isEdit && editItem) {
        saved = await updateGrammarItem(language, editItem.id, {
          statement: statement.trim(),
          descriptions: descs,
          examples: filteredExamples.length > 0 ? filteredExamples : undefined,
          words: wordsArr.length > 0 ? wordsArr : undefined,
          level: level.trim() || undefined,
          tags: tagsArr.length > 0 ? tagsArr : undefined,
        });
      } else {
        const id = `grammar-${language}-${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
        saved = await smartAddGrammarItem(language, {
          id,
          statement: statement.trim(),
          descriptions: descs,
          examples: filteredExamples.length > 0 ? filteredExamples : undefined,
          words: wordsArr.length > 0 ? wordsArr : undefined,
          level: level.trim() || undefined,
          tags: tagsArr.length > 0 ? tagsArr : undefined,
        });
      }

      // Diff group membership and sync (edit mode only — new items have no existing groups).
      if (isEdit && editItem) {
        const original = new Set(
          groups.filter((g) => g.grammarIds.includes(saved.id)).map((g) => g.id)
        );
        const toAdd = [...selectedGroupIds].filter((id) => !original.has(id));
        const toRemove = [...original].filter((id) => !selectedGroupIds.has(id));
        await Promise.all([
          ...toAdd.map((gid) => modifyGrammarGroupMembers(language, gid, [saved.id], "add")),
          ...toRemove.map((gid) => modifyGrammarGroupMembers(language, gid, [saved.id], "remove")),
        ]);
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
        <h2 className="mb-4 text-lg font-semibold text-gray-100">
          {t(isEdit ? "editGrammar" : "addGrammar")}
        </h2>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Statement */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("grammarStatement")} *</label>
            <input
              type="text"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              placeholder="e.g. to + V, 别+V+了"
              required
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
            />
          </div>

          {/* Groups (edit mode only) */}
          {isEdit && groups.length > 0 && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("groups")}</label>
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-600 bg-gray-700 p-2">
                {groups.map((group) => {
                  const selected = selectedGroupIds.has(group.id);
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => {
                        setSelectedGroupIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        });
                      }}
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        selected
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-600 text-gray-300 hover:bg-gray-500"
                      }`}
                    >
                      {group.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Descriptions */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm text-gray-400">{t("grammarDescriptions")} *</label>
              <button
                type="button"
                onClick={() =>
                  setDescriptions([
                    ...descriptions,
                    { partOfSpeech: "", translations: [{ lang: "en", text: "" }], pinyinsRaw: "" },
                  ])
                }
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                + {t("addDefinition")}
              </button>
            </div>
            {descriptions.map((desc, di) => (
              <div key={di} className="mb-3 rounded-lg border border-gray-600 bg-gray-700 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={desc.partOfSpeech}
                    onChange={(e) => updateDescription(di, { partOfSpeech: e.target.value })}
                    placeholder={t("category")}
                    className="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                  />
                  {descriptions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setDescriptions(descriptions.filter((_, j) => j !== di))}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      {t("removeDefinition")}
                    </button>
                  )}
                </div>
                {isChinese && (
                  <input
                    type="text"
                    value={desc.pinyinsRaw ?? ""}
                    onChange={(e) => updateDescription(di, { pinyinsRaw: e.target.value })}
                    placeholder="Pinyin(s), comma-separated"
                    className="mb-2 w-full rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                  />
                )}
                {desc.translations.map((tr, ti) => (
                  <div key={ti} className="mb-1 flex gap-2">
                    <select
                      value={tr.lang}
                      onChange={(e) => updateTranslation(di, ti, { lang: e.target.value })}
                      aria-label={t("definitionLanguage")}
                      className="w-28 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                    >
                      {!ALL_KNOWN_LANGUAGES.some((l) => l.code === tr.lang) && (
                        <option value={tr.lang}>{tr.lang || t("definitionLanguage")}</option>
                      )}
                      {ALL_KNOWN_LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>{l.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={tr.text}
                      onChange={(e) => updateTranslation(di, ti, { text: e.target.value })}
                      placeholder={t("definitionText")}
                      className="flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                    />
                    {desc.translations.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          updateDescription(di, {
                            translations: desc.translations.filter((_, j) => j !== ti),
                          })
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
                    updateDescription(di, {
                      translations: [...desc.translations, { lang: "en", text: "" }],
                    })
                  }
                  className="mt-1 text-xs text-blue-400 hover:text-blue-300"
                >
                  + {t("addDefinition")}
                </button>
              </div>
            ))}
          </div>

          {/* Related words */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("grammarTerms")}</label>
            {wordsList.map((w, i) => (
              <div key={i}>
                <InsertButton
                  onInsert={() => {
                    const n = [...wordsList];
                    n.splice(i, 0, "");
                    setWordsList(n);
                  }}
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={w}
                    onChange={(e) => {
                      const n = [...wordsList];
                      n[i] = e.target.value;
                      setWordsList(n);
                    }}
                    placeholder="related term"
                    className="flex-1 rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setWordsList(wordsList.filter((_, j) => j !== i))}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    {t("removeExample")}
                  </button>
                </div>
              </div>
            ))}
            <InsertButton onInsert={() => setWordsList([...wordsList, ""])} />
          </div>

          {/* Examples */}
          <ExampleSentenceEditor
            language={language}
            examples={examples}
            setExamples={setExamples}
            selectedGroupIds={selectedGroupIds}
          />

          {/* Level */}
          {LEVEL_OPTIONS[language] && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("level")}</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                <option value="">—</option>
                {!LEVEL_OPTIONS[language].includes(level) && level && (
                  <option value={level}>{level}</option>
                )}
                {LEVEL_OPTIONS[language].map((lv) => (
                  <option key={lv} value={lv}>{lv}</option>
                ))}
              </select>
            </div>
          )}

          {/* Tags */}
          <div>
            <label className="mb-1 block text-sm text-gray-400">Tags</label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="comma,separated,tags"
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
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
              disabled={saving || !statement.trim()}
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
