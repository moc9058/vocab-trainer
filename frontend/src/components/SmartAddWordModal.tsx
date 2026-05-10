import { useState, useMemo, useEffect, useRef, Fragment } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP, urlLanguageToIsoCode } from "../settings/defaults";
import { smartAddWord, lookupWord, checkTerms, getGroups, modifyGroupMembers } from "../api/vocab";
import { displayTranslation, type Word, type WordGroup } from "../types";

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
  examples?: { sentence: string; translation: string; userSplits?: string[] }[];
  level?: string;
  flag?: boolean;
  groupIds?: string[];
};

interface Props {
  onSave: (word: Word) => void;
  onClose: () => void;
  prefill?: Prefill;
  defaultLanguage?: string;
  onJumpToWord?: (wordId: string, term: string) => void;
  onQueue?: (term: string, language: string, payload: SmartAddPayload) => void;
  pendingTerms?: Set<string>;
  refreshSignal?: number;
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

export default function SmartAddWordModal({ onSave, onClose, prefill, defaultLanguage, onJumpToWord, onQueue, pendingTerms, refreshSignal }: Props) {
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
  const [groups, setGroups] = useState<WordGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
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
  const prevExamplesLengthRef = useRef(0);

  const [existingTerms, setExistingTerms] = useState<Map<string, string>>(new Map());
  const [checkingTerms, setCheckingTerms] = useState(false);
  const [busySegments, setBusySegments] = useState<Set<string>>(new Set());
  const [segmentFlags, setSegmentFlags] = useState<Map<string, boolean>>(new Map());
  const [queuedSegments, setQueuedSegments] = useState<Set<string>>(new Set());
  const [segmentAddError, setSegmentAddError] = useState<string | null>(null);
  const segmentVersionRef = useRef(0);
  const lastExampleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (examples.length > prevExamplesLengthRef.current) {
      lastExampleRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    prevExamplesLengthRef.current = examples.length;
  }, [examples.length]);

  useEffect(() => {
    setSelectedGroupIds(new Set());
    getGroups(wordLanguage)
      .then((loadedGroups) => {
        setGroups(loadedGroups);
        const latestGroup = loadedGroups.at(-1);
        setSelectedGroupIds(latestGroup ? new Set([latestGroup.id]) : new Set());
      })
      .catch(() => setGroups([]));
  }, [wordLanguage]);

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

  useEffect(() => {
    if (wordLanguage !== "chinese") return;
    const texts = [...new Set(
      examples.flatMap((ex) => {
        if (ex.sentence && /[\s　]/.test(ex.sentence)) {
          return [...ex.sentence.matchAll(/([\p{Script=Han}a-zA-Z]+)/gu)]
            .map((m) => m[1])
            .filter((t) => !/^\p{P}+$/u.test(t));
        }
        return [];
      })
    )];
    if (texts.length === 0) {
      setExistingTerms(new Map());
      setCheckingTerms(false);
      return;
    }
    setCheckingTerms(true);
    const v = ++segmentVersionRef.current;
    const timer = setTimeout(() => {
      checkTerms(wordLanguage, texts)
        .then(({ existing }) => {
          if (v !== segmentVersionRef.current) return;
          const existingMap = new Map(Object.entries(existing));
          setExistingTerms(existingMap);
          setQueuedSegments((prev) => {
            const next = new Set(prev);
            for (const key of prev) {
              const { chipText } = parseQueuedSegmentKey(key);
              if (existingMap.has(chipText) || !pendingTerms?.has(chipText)) {
                next.delete(key);
              }
            }
            return next;
          });
          setCheckingTerms(false);
        })
        .catch(() => {
          if (v === segmentVersionRef.current) setCheckingTerms(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [examples, wordLanguage, refreshSignal]);

  useEffect(() => {
    setQueuedSegments((prev) => {
      const next = new Set(prev);
      for (const key of prev) {
        const { chipText } = parseQueuedSegmentKey(key);
        if (existingTerms.has(chipText) || !pendingTerms?.has(chipText)) {
          next.delete(key);
        }
      }
      return next;
    });
  }, [existingTerms, pendingTerms]);

  function getQueuedSegmentKey(chipText: string, sentence: string): string {
    return `${chipText}\u0000${sentence.replace(/[\s　]+/g, "")}`;
  }

  function parseQueuedSegmentKey(key: string): { chipText: string; sentence: string } {
    const [chipText, sentence = ""] = key.split("\u0000");
    return { chipText, sentence };
  }

  async function handleAddSegment(chipText: string, sentence: string, translation: string) {
    const queuedKey = getQueuedSegmentKey(chipText, sentence);
    if (existingTerms.has(chipText) || pendingTerms?.has(chipText) || queuedSegments.has(queuedKey)) return;
    const groupIds = getSelectedGroupIdsPayload();
    if (onQueue) {
      setQueuedSegments((prev) => new Set(prev).add(queuedKey));
      onQueue(chipText, wordLanguage, {
        term: chipText,
        examples: [{ sentence: sentence.replace(/[\s　]+/g, ""), translation }],
        flag: segmentFlags.get(chipText) ?? true,
        groupIds,
      });
      return;
    }
    segmentVersionRef.current++;
    setBusySegments((prev) => new Set(prev).add(chipText));
    try {
      const { generatedWords: _gw, ...addedWord } = await smartAddWord(wordLanguage, {
        term: chipText,
        examples: [{ sentence: sentence.replace(/[\s　]+/g, ""), translation }],
        flag: segmentFlags.get(chipText) ?? true,
        groupIds,
      });
      if (groupIds && groupIds.length > 0) {
        const updatedGroups = await Promise.all(
          groupIds.map((groupId) => modifyGroupMembers(wordLanguage, groupId, [addedWord.id], "add"))
        );
        setGroups((prev) =>
          prev.map((group) => updatedGroups.find((updated) => updated.id === group.id) ?? group)
        );
      }
      setExistingTerms((prev) => new Map(prev).set(chipText, addedWord.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSegmentAddError(msg);
      setTimeout(() => setSegmentAddError(null), 3000);
    } finally {
      setBusySegments((prev) => { const n = new Set(prev); n.delete(chipText); return n; });
    }
  }

  function getDefLangKey(def: { langSelect: string }): string {
    return def.langSelect;
  }

  function getChipInfo(sentence: string): Array<{ text: string; sepIsSpaceOnly: boolean }> {
    const chips: Array<{ text: string; sepIsSpaceOnly: boolean }> = [];
    let prevSep = "";
    for (const m of sentence.matchAll(/([\p{Script=Han}a-zA-Z]+)|([^\p{Script=Han}a-zA-Z]+)/gu)) {
      if (m[1]) {
        chips.push({ text: m[1], sepIsSpaceOnly: chips.length > 0 && /^[\s　]+$/.test(prevSep) });
        prevSep = "";
      } else {
        prevSep = m[2];
      }
    }
    return chips;
  }

  function removeSepAt(sentence: string, afterIdx: number): string {
    let wordCount = 0;
    return [...sentence.matchAll(/([\p{Script=Han}a-zA-Z]+)|([^\p{Script=Han}a-zA-Z]+)/gu)]
      .map((m) => {
        if (m[1]) { wordCount++; return m[1]; }
        if (wordCount === afterIdx + 1 && /^[\s　]+$/.test(m[2])) return "";
        return m[2];
      })
      .join("");
  }

  function getSelectedGroupIdsPayload(): string[] | undefined {
    return selectedGroupIds.size > 0 ? [...selectedGroupIds] : undefined;
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
    const validExamples = examples
      .filter((ex) => ex.sentence.trim())
      .map((ex) => {
        if (wordLanguage === "chinese") {
          const cleanSentence = ex.sentence.replace(/[\s　]+/g, "");
          if (/[\s　]/.test(ex.sentence)) {
            const splits = ex.sentence.match(/[\p{Script=Han}a-zA-Z]+/gu) ?? [];
            if (splits.length >= 2) return { sentence: cleanSentence, translation: ex.translation, userSplits: splits };
          }
          return { sentence: cleanSentence, translation: ex.translation };
        }
        return ex;
      });
    return {
      term: term.trim(),
      transliteration: wordLanguage === "chinese" ? (transliteration.trim() || undefined) : undefined,
      definitions: defs,
      topics: topics.length > 0 ? topics : undefined,
      examples: validExamples.length > 0 ? validExamples : undefined,
      level: level || undefined,
      flag: flagForReview,
      groupIds: getSelectedGroupIdsPayload(),
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
    const latestGroup = groups.at(-1);
    setSelectedGroupIds(latestGroup ? new Set([latestGroup.id]) : new Set());
    setExamples([{ sentence: "", translation: "" }]);
    setExistingWord(null);
    setError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim() || saving || queued || pendingTerms?.has(term.trim())) return;

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
      const groupIds = payload.groupIds ?? [];
      if (groupIds.length > 0) {
        const updatedGroups = await Promise.all(
          groupIds.map((groupId) => modifyGroupMembers(language, groupId, [word.id], "add"))
        );
        setGroups((prev) =>
          prev.map((group) => updatedGroups.find((updated) => updated.id === group.id) ?? group)
        );
      }
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
            {!checking && !existingWord && pendingTerms?.has(term.trim()) && (
              <p className="mt-1 text-xs text-amber-400">⏳ Already queued</p>
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
                    className="rounded-md border border-amber-400 bg-amber-500/20 px-2.5 py-1 text-xs text-amber-300 hover:bg-amber-500/30 cursor-pointer"
                  >
                    Edit word →
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

          {/* Groups (optional) */}
          {groups.length > 0 && (
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
                      className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
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
              <div key={i} ref={i === examples.length - 1 ? lastExampleRef : undefined} className="mb-2 rounded-lg border border-gray-600 bg-gray-700 p-2 space-y-1">
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
                  placeholder={wordLanguage === "chinese" ? `${t("sentence")} (use spaces to split)` : t("sentence")}
                  className="w-full resize-none overflow-hidden rounded border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
                {wordLanguage === "chinese" && (() => {
                  const chips = getChipInfo(ex.sentence);
                  if (chips.length < 2) return null;
                  return (
                    <div className="flex flex-wrap items-start gap-1">
                      {(() => {
                      const anyDeactivated = chips.some(
                        (c) =>
                          c.text.trim().length > 0 &&
                          !/^\p{P}+$/u.test(c.text) &&
                          !(term.trim() && c.text === term.trim()) &&
                          !existingTerms.has(c.text) &&
                          !pendingTerms?.has(c.text) &&
                          !queuedSegments.has(getQueuedSegmentKey(c.text, ex.sentence))
                      );
                      return chips.map((chip, pi) => {
                        const isPunct = /^\p{P}+$/u.test(chip.text) || chip.text.trim().length === 0;
                        const isSelf  = !isPunct && !!term.trim() && chip.text === term.trim();
                        const exists  = isSelf || (!isPunct && existingTerms.has(chip.text));
                        const queued  = !isPunct && !isSelf && !exists && (queuedSegments.has(getQueuedSegmentKey(chip.text, ex.sentence)) || !!pendingTerms?.has(chip.text));
                        const checking = !isPunct && !isSelf && !exists && !queued && checkingTerms;
                        const busy    = busySegments.has(chip.text);
                        return (
                          <Fragment key={pi}>
                            <div className="flex flex-col">
                              <button
                                type="button"
                                disabled={busy || queued || exists || checking || isPunct}
                                onClick={() => { if (!exists && !queued && !checking && !isPunct) handleAddSegment(chip.text, ex.sentence, ex.translation); }}
                                className={`rounded-full px-2 py-0.5 text-xs transition-colors ${busy ? "opacity-50 cursor-wait" : ""} ${
                                  isPunct   ? "text-gray-600 cursor-default"
                                  : isSelf  ? "border border-gray-500/40 bg-gray-800/40 text-gray-500 cursor-default"
                                  : exists  ? "border border-green-500/40 bg-green-900/20 text-green-300 cursor-default"
                                  : queued  ? "border border-amber-500/40 bg-amber-900/20 text-amber-300 cursor-wait"
                                  : checking? "border border-amber-500/40 bg-amber-900/20 text-amber-300 cursor-wait"
                                  : "border border-blue-500/40 bg-blue-900/20 text-blue-300 hover:bg-blue-800/40"
                                }`}
                              >
                                {isPunct || isSelf ? chip.text : exists ? `✓ ${chip.text}` : queued ? `⋯ ${chip.text}` : checking ? `⋯ ${chip.text}` : `+ ${chip.text}`}
                              </button>
                              {anyDeactivated && (
                                <div className="mt-0.5 h-3.5 flex justify-center items-center">
                                  {!isPunct && !isSelf && !exists && !queued && !checking && (
                                    <label
                                      className={`flex items-center ${busy ? "cursor-default opacity-50" : "cursor-pointer"}`}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={segmentFlags.get(chip.text) ?? true}
                                        onChange={() => setSegmentFlags((prev) => {
                                          const next = new Map(prev);
                                          next.set(chip.text, !(prev.get(chip.text) ?? true));
                                          return next;
                                        })}
                                        disabled={busy}
                                        className="accent-amber-500 w-3 h-3"
                                        aria-label={`Flag ${chip.text} for review`}
                                      />
                                    </label>
                                  )}
                                </div>
                              )}
                            </div>
                            {pi < chips.length - 1 && (
                              chips[pi + 1].sepIsSpaceOnly ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = [...examples];
                                    next[i] = { ...next[i], sentence: removeSepAt(ex.sentence, pi) };
                                    setExamples(next);
                                  }}
                                  className="self-start mt-0.5 px-0.5 text-xs leading-none text-gray-500 hover:text-red-400"
                                  title="Remove segment boundary"
                                >
                                  ╱
                                </button>
                              ) : (
                                <span className="self-start mt-0.5 text-xs text-gray-600">·</span>
                              )
                            )}
                          </Fragment>
                        );
                      });
                    })()}
                    </div>
                  );
                })()}
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

          {segmentAddError && (
            <p className="text-xs text-red-400">{segmentAddError}</p>
          )}

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
              disabled={saving || queued || !term.trim() || !!pendingTerms?.has(term.trim())}
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
