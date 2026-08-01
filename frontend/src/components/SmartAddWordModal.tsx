import { useState, useMemo, useEffect, useRef, Fragment } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { LANG_LABEL_MAP, urlLanguageToIsoCode } from "../settings/defaults";
import { LEVEL_OPTIONS } from "../constants/levels";
import { smartAddWord, lookupWord, checkTerms, getGroups, createGroup, modifyGroupMembers } from "../api/vocab";
import { categoryGroups, displayTranslation, defaultWordGroup, type Word, type WordDraft, type WordGroup } from "../types";
import GroupBSelect from "./GroupBSelect";
import PinyinInput from "./PinyinInput";

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

type WordDraftSavePayload = Partial<Omit<WordDraft, "id" | "language" | "createdAt">>;

interface Props {
  onSave: (word: Word) => void;
  onClose: () => void;
  prefill?: Prefill;
  defaultLanguage?: string;
  onJumpToWord?: (wordId: string, term: string) => void;
  /** Shared word queue. The main submit passes `opts` (draft registration:
   *  missing group names + draftId); segment-chip adds never do. */
  onQueue?: (term: string, language: string, payload: SmartAddPayload, opts?: { groupNames?: string[]; draftId?: string }) => void;
  /** Terms currently queued/processing in the shared word-add queue (amber "⋯"). */
  pendingTerms?: Set<string>;
  /** Cumulative set of terms the queue has finished adding this session — the
   *  authoritative "now in DB" signal that flips a chip to green "✓". */
  succeededTerms?: Set<string>;
  /** Retained for prop compatibility; chip status no longer needs it. */
  refreshSignal?: number;
  /** Prefill for reviewing an uploaded word draft. The submit still goes
   *  through the normal smart-add path. */
  initialItem?: Pick<WordDraft, "term" | "transliteration" | "definitions" | "examples" | "level" | "topics">;
  /** Word-group NAMES to preselect (draft review passes the drafts panel's
   *  selected registration group): existing ones are preselected; missing ones
   *  are created and joined on save (directly on the non-queue path; via the
   *  queue worker's `groupNames` on the queue path). */
  initialGroups?: string[];
  /** Category-B word-group IDs to preselect (draft review passes the drafts
   *  panel's Group B selection). Merged into the outgoing `groupIds`. */
  initialGroupBIds?: string[];
  /** Draft review: the draft under review. Queue-mode registration threads it
   *  through so the queue deletes the draft only after full success, and the
   *  modal closes right after enqueueing. */
  draftId?: string;
  /** Draft review: when provided, the primary "Save Draft" button (and Enter)
   *  writes the edits back to the draft WITHOUT promoting, and a separate
   *  "Register" button runs the normal smart-add path. Should throw on failure
   *  so the modal can surface the error. */
  onDraftSave?: (updates: WordDraftSavePayload) => Promise<void> | void;
}

// LANG_OPTIONS is now derived from settings in the component

/** Re-insert spaces into a draft sentence at its `segments` boundaries so the
 *  Chinese chip workflow (which derives chips from spaces) picks them up. Falls
 *  back to the raw sentence when the splits don't match it. */
function spaceSentenceBySplits(sentence: string, splits?: string[]): string {
  if (!splits || splits.length < 2) return sentence;
  let out = "";
  let cursor = 0;
  for (const split of splits) {
    const idx = sentence.indexOf(split, cursor);
    if (idx === -1) return sentence;
    out += sentence.slice(cursor, idx) + split + " ";
    cursor = idx + split.length;
  }
  out += sentence.slice(cursor);
  return out.trimEnd();
}

const CATEGORIES = [
  "noun", "verb", "adjective", "adverb", "preposition", "conjunction",
  "particle", "numeral", "classifier", "determiner", "pronoun",
  "interjection", "idiom", "set phrase", "phrasal verb", "collocation",
  "proverb", "greeting",
] as const;

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

export default function SmartAddWordModal({ onSave, onClose, prefill, defaultLanguage, onJumpToWord, onQueue, pendingTerms, succeededTerms, initialItem, initialGroups, initialGroupBIds, draftId, onDraftSave }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const LANG_OPTIONS = useMemo(
    () => settings.languageOrder.map((c) => ({ value: c, label: LANG_LABEL_MAP[c] ?? c })),
    [settings.languageOrder],
  );
  const wordLanguage = prefill?.language || defaultLanguage || "english";
  const currentIsoCode = urlLanguageToIsoCode(wordLanguage) ?? "";
  const [term, setTerm] = useState(prefill?.term ?? initialItem?.term ?? "");
  const [transliteration, setTransliteration] = useState(initialItem?.transliteration ?? "");
  const [definitions, setDefinitions] = useState<{ langSelect: string; text: string }[]>(() => {
    const draftDef = initialItem?.definitions?.[0];
    if (draftDef && Object.keys(draftDef.text || {}).length > 0) {
      return Object.entries(draftDef.text).map(([lang, text]) => ({ langSelect: lang, text }));
    }
    const langSelect = settings.languageOrder[0] ?? "en";
    return [{ langSelect, text: "" }];
  });
  const [grammaticalCategory, setGrammaticalCategory] = useState(initialItem?.definitions?.[0]?.partOfSpeech ?? "");
  const [level, setLevel] = useState(initialItem?.level ?? "");
  const [topics, setTopics] = useState<string[]>(initialItem?.topics ?? []);
  const [groups, setGroups] = useState<WordGroup[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  // Category-B groups to additionally join. Kept separate from `selectedGroupIds`
  // (the Group A chips) and merged only in the outgoing payload.
  const [groupBIds, setGroupBIds] = useState<string[]>(initialGroupBIds ?? []);
  const [examples, setExamples] = useState<{ sentence: string; translation: string }[]>(
    prefill?.example
      ? [prefill.example]
      : initialItem?.examples && initialItem.examples.length > 0
        ? initialItem.examples.map((ex) => ({
            sentence: wordLanguage === "chinese" ? spaceSentenceBySplits(ex.sentence, ex.segments) : ex.sentence,
            translation: ex.translation ?? "",
          }))
        : [{ sentence: "", translation: "" }],
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

  // DB-existence poll result: words present before this session. Replaced
  // wholesale on each poll; only feeds the green "✓" state for pre-existing words.
  const [existingTerms, setExistingTerms] = useState<Map<string, string>>(new Map());
  const [checkingTerms, setCheckingTerms] = useState(false);
  const [busySegments, setBusySegments] = useState<Set<string>>(new Set());
  const [segmentFlags, setSegmentFlags] = useState<Map<string, boolean>>(new Map());
  // Terms a *direct-mode* `smartAddWord` (no queue) added this session. Queue-mode
  // adds are tracked authoritatively by the parent's `succeededTerms`.
  const [addedTerms, setAddedTerms] = useState<Set<string>>(new Set());
  const [segmentAddError, setSegmentAddError] = useState<string | null>(null);
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
      .then((allGroups) => {
        // The group chips are the Group A picker; Group B is a separate control.
        const loadedGroups = categoryGroups(allGroups, "A");
        setGroups(loadedGroups);
        if (initialGroups && initialGroups.length > 0) {
          // Draft review: preselect the draft's group names that already exist.
          // Missing names are created + joined on save.
          const names = new Set(initialGroups.map((n) => n.trim()).filter(Boolean));
          setSelectedGroupIds(new Set(loadedGroups.filter((g) => names.has(g.name)).map((g) => g.id)));
          return;
        }
        const defaultGroup = defaultWordGroup(loadedGroups);
        setSelectedGroupIds(defaultGroup ? new Set([defaultGroup.id]) : new Set());
      })
      .catch(() => setGroups([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
        if (ex.sentence && /[\s　]/.test(ex.sentence) && sentenceComplete(ex.sentence)) {
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
    // Debounced existence poll. Sole job: mark words already in the DB as green
    // on open / after edits. Queue-add completion is signalled by `succeededTerms`,
    // so this needs no `refreshSignal`/`pendingTerms` dep and no version guard —
    // a `cancelled` flag ignores a stale response after the inputs change.
    let cancelled = false;
    const timer = setTimeout(() => {
      checkTerms(wordLanguage, texts)
        .then(({ existing }) => {
          if (cancelled) return;
          setExistingTerms(new Map(Object.entries(existing)));
          setCheckingTerms(false);
        })
        .catch(() => {
          if (!cancelled) setCheckingTerms(false);
        });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [examples, wordLanguage]);

  // True once a chip's word is confirmed in the DB (pre-existing, queue-added,
  // or direct-added) — the green "✓" state.
  function isAdded(chipText: string): boolean {
    return existingTerms.has(chipText) || !!succeededTerms?.has(chipText) || addedTerms.has(chipText);
  }

  async function handleAddSegment(chipText: string, sentence: string, translation: string) {
    if (isAdded(chipText) || pendingTerms?.has(chipText)) return;
    const groupIds = getSelectedGroupIdsPayload();
    if (onQueue) {
      // Enqueue; the parent's `pendingTerms` (amber) → `succeededTerms` (green)
      // drives the chip's state authoritatively.
      onQueue(chipText, wordLanguage, {
        term: chipText,
        examples: [{ sentence: sentence.replace(/[\s　]+/g, ""), translation }],
        flag: segmentFlags.get(chipText) ?? true,
        groupIds,
      });
      return;
    }
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
      setAddedTerms((prev) => new Set(prev).add(chipText));
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

  function sentenceComplete(sentence: string): boolean {
    return /[。！？…\.!?"'」』]$/.test(sentence.trim());
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
    const merged = new Set([...selectedGroupIds, ...groupBIds]);
    return merged.size > 0 ? [...merged] : undefined;
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
    const defaultGroup = defaultWordGroup(groups);
    setSelectedGroupIds(defaultGroup ? new Set([defaultGroup.id]) : new Set());
    setExamples([{ sentence: "", translation: "" }]);
    setExistingWord(null);
    setError("");
  }

  // Save the current form state back to the draft (no promotion, no LLM).
  // Chinese chip splits are stored as `segments` (plain segment texts) so the
  // segmentation survives the round-trip to the next review.
  async function handleDraftSave(e?: React.FormEvent) {
    e?.preventDefault();
    if (!onDraftSave || !term.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const p = buildPayload();
      const draftExamples = examples
        .filter((ex) => ex.sentence.trim())
        .map((ex) => {
          if (wordLanguage === "chinese") {
            const splits = /[\s　]/.test(ex.sentence)
              ? (ex.sentence.match(/[\p{Script=Han}a-zA-Z]+/gu) ?? [])
              : [];
            return {
              sentence: ex.sentence.replace(/[\s　]+/g, ""),
              translation: ex.translation,
              ...(splits.length >= 2 ? { segments: splits } : {}),
            };
          }
          return { sentence: ex.sentence.trim(), translation: ex.translation };
        });
      await onDraftSave({
        term: p.term,
        transliteration: transliteration.trim(),
        definitions: p.definitions ?? [],
        examples: draftExamples,
        level: level || "",
        topics,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!term.trim() || saving || queued || pendingTerms?.has(term.trim())) return;

    const language = wordLanguage;
    if (!language) return;

    const payload = buildPayload();

    // Queue mode: enqueue immediately. Draft review closes so the user can move
    // on to the next draft (the queue deletes the draft itself on success, and
    // creates any missing draft groups via `groupNames`); plain queue-mode adds
    // instead reset the form for rapid consecutive entry.
    if (onQueue) {
      const missingNames = initialGroups
        ? [...new Set(initialGroups.map((n) => n.trim()).filter(Boolean))].filter(
            (name) => !groups.some((g) => g.name === name)
          )
        : [];
      onQueue(
        term.trim(),
        language,
        payload,
        missingNames.length > 0 || draftId
          ? {
              ...(missingNames.length > 0 ? { groupNames: missingNames } : {}),
              ...(draftId ? { draftId } : {}),
            }
          : undefined
      );
      setQueued(true);
      setTimeout(() => {
        setQueued(false);
        if (draftId) onClose();
        else resetForm();
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
      // Draft review: any of the draft's group names that don't exist yet are
      // created here and the new word joined (existing names were preselected
      // above and handled through the normal groupIds path).
      if (initialGroups && initialGroups.length > 0) {
        const knownNames = new Set(groups.map((g) => g.name));
        const missing = [...new Set(initialGroups.map((n) => n.trim()).filter(Boolean))]
          .filter((name) => !knownNames.has(name));
        for (const name of missing) {
          const created = await createGroup(language, name);
          await modifyGroupMembers(language, created.id, [word.id], "add");
        }
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

        <form onSubmit={onDraftSave ? handleDraftSave : handleSubmit} className="flex flex-col gap-4">
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
              <PinyinInput
                value={transliteration}
                onChange={setTransliteration}
                placeholder="LLM will generate if empty"
                className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
              />
            </div>
          )}

          {/* Groups (optional) */}
          {groups.length > 0 && (
            <div className="order-2">
              <label className="mb-1 block text-sm text-gray-400">{t("groups")}</label>
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-gray-600 bg-gray-700 p-2">
                {groups.map((group) => {
                  const selected = selectedGroupIds.has(group.id);
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => {
                        // Single-select: a word belongs to at most ONE category-A
                        // group and the server enforces it on write, so letting two
                        // be checked here would only promise what the save cannot keep.
                        setSelectedGroupIds((prev) =>
                          prev.has(group.id) ? new Set() : new Set([group.id])
                        );
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

          <div className="order-2">
            <GroupBSelect
              kind="word"
              language={wordLanguage}
              selectedIds={groupBIds}
              onChange={setGroupBIds}
            />
          </div>

          {/* Definitions (optional) */}
          <div className="order-2">
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
                <textarea
                  rows={2}
                  value={def.text}
                  onChange={(e) => {
                    const next = [...definitions];
                    next[i] = { ...next[i], text: e.target.value };
                    setDefinitions(next);
                  }}
                  placeholder="LLM will generate if empty"
                  className="flex-1 resize-y rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-400 focus:outline-none"
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
          <div className="order-2">
            <label className="mb-1 block text-sm text-gray-400">{t("category")}</label>
            <select
              value={grammaticalCategory}
              onChange={(e) => setGrammaticalCategory(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            >
              <option value="">-- LLM will generate --</option>
              {grammaticalCategory && !(CATEGORIES as readonly string[]).includes(grammaticalCategory) && (
                <option value={grammaticalCategory}>{grammaticalCategory}</option>
              )}
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          {/* Level (optional, non-English languages with defined levels) */}
          {LEVEL_OPTIONS[wordLanguage] && (
            <div className="order-2">
              <label className="mb-1 block text-sm text-gray-400">{t("levelsColumn")}</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                <option value="">-- LLM will assign --</option>
                {level && !LEVEL_OPTIONS[wordLanguage].includes(level) && (
                  <option value={level}>{level}</option>
                )}
                {LEVEL_OPTIONS[wordLanguage].map((lv) => (
                  <option key={lv} value={lv}>{lv}</option>
                ))}
              </select>
            </div>
          )}

          {/* Topics (optional, multi-select) */}
          <div className="order-2">
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
          <div className="order-1">
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
                {wordLanguage === "chinese" && sentenceComplete(ex.sentence) && (() => {
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
                          !isAdded(c.text) &&
                          !pendingTerms?.has(c.text) &&
                          !busySegments.has(c.text) &&
                          !checkingTerms
                      );
                      return chips.map((chip, pi) => {
                        const isPunct = /^\p{P}+$/u.test(chip.text) || chip.text.trim().length === 0;
                        const isSelf  = !isPunct && !!term.trim() && chip.text === term.trim();
                        // Three authoritative states: added (green ✓) / in-flight
                        // (amber ⋯) / non-existing (blue +). `inFlight` folds
                        // queued+processing (`pendingTerms`), a direct add (`busy`),
                        // and the initial existence poll (`checkingTerms`).
                        const exists  = isSelf || (!isPunct && isAdded(chip.text));
                        const inFlight = !isPunct && !isSelf && !exists &&
                          (!!pendingTerms?.has(chip.text) || busySegments.has(chip.text) || checkingTerms);
                        return (
                          <Fragment key={pi}>
                            <div className="flex flex-col">
                              <button
                                type="button"
                                disabled={isPunct || exists || inFlight}
                                onClick={() => { if (!isPunct && !exists && !inFlight) handleAddSegment(chip.text, ex.sentence, ex.translation); }}
                                className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
                                  isPunct    ? "text-gray-600 cursor-default"
                                  : isSelf   ? "border border-gray-500/40 bg-gray-800/40 text-gray-500 cursor-default"
                                  : exists   ? "border border-green-500/40 bg-green-900/20 text-green-300 cursor-default"
                                  : inFlight ? "border border-amber-500/40 bg-amber-900/20 text-amber-300 cursor-wait"
                                  : "border border-blue-500/40 bg-blue-900/20 text-blue-300 hover:bg-blue-800/40"
                                }`}
                              >
                                {isPunct || isSelf ? chip.text : exists ? `✓ ${chip.text}` : inFlight ? `⋯ ${chip.text}` : `+ ${chip.text}`}
                              </button>
                              {anyDeactivated && (
                                <div className="mt-0.5 h-3.5 flex justify-center items-center">
                                  {!isPunct && !isSelf && !exists && !inFlight && (
                                    <label
                                      className="flex items-center cursor-pointer"
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
            <p className="order-2 text-xs text-red-400">{segmentAddError}</p>
          )}

          {/* Flag for review */}
          <label className="order-2 flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={flagForReview}
              onChange={(e) => setFlagForReview(e.target.checked)}
              className="accent-amber-500"
            />
            <span className="text-sm text-gray-300">{t("flagForReview")}</span>
          </label>

          {/* Actions */}
          <div className="order-2 flex justify-end gap-3 pt-2">
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
              {saving ? t("addingWord") : queued ? "✓ Queued" : onDraftSave ? t("saveDraft") : t("save")}
            </button>
            {/* Draft review mode: promotion is a separate, explicit action. */}
            {onDraftSave && (
              <button
                type="button"
                onClick={() => handleSubmit()}
                disabled={saving || queued || !term.trim() || !!pendingTerms?.has(term.trim())}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-500 disabled:opacity-50"
              >
                {queued ? "✓ Queued" : saving ? "..." : t("registerWord")}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
