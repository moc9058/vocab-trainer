import { useEffect, useRef, useState, Fragment } from "react";
import { useI18n } from "../i18n/context";
import { checkTerms, smartAddWord, modifyGroupMembers, getGroups } from "../api/vocab";
import { displayTranslation, type WordGroup } from "../types";

export interface ExampleFormState {
  id?: string;
  sentence: string;
  translation: string;
  originalTranslation: string | Record<string, string>;
  locked: boolean;
}

export type ExampleSegmentQueuePayload = {
  term: string;
  examples: { sentence: string; translation: string }[];
  flag: boolean;
  groupIds?: string[];
};

interface Props {
  language: string;
  examples: ExampleFormState[];
  setExamples: (next: ExampleFormState[]) => void;
  /** Form-level group memberships of the parent word/grammar. Currently unused
   *  by the chip-`+` workflow (each chip carries its own group via the
   *  per-chip selector). Kept in the prop signature so callers don't need to
   *  change shape. */
  selectedGroupIds?: Set<string>;
  currentTerm?: string;
  pendingTerms?: Set<string>;
  refreshSignal?: number;
  onQueue?: (term: string, language: string, payload: ExampleSegmentQueuePayload) => void;
}

export default function ExampleSentenceEditor({
  language,
  examples,
  setExamples,
  currentTerm,
  pendingTerms,
  refreshSignal,
  onQueue,
}: Props) {
  const { t } = useI18n();

  const [existingTerms, setExistingTerms] = useState<Map<string, string>>(new Map());
  const [checkingTerms, setCheckingTerms] = useState(false);
  const [busySegments, setBusySegments] = useState<Set<string>>(new Set());
  const [segmentFlags, setSegmentFlags] = useState<Map<string, boolean>>(new Map());
  const [segmentAddError, setSegmentAddError] = useState<string | null>(null);
  const segmentVersionRef = useRef(0);

  // Vocab word-groups (sorted latest-first by createdAt). Used to populate the
  // per-chip group selector; the chip workflow always assigns to a *vocab*
  // group even when this editor is mounted under GrammarFormModal.
  const [wordGroups, setWordGroups] = useState<WordGroup[]>([]);
  // Per-chip group override. Key = chip text; value = groupId or "" (no group).
  // Absent key falls back to the latest group (wordGroups[0]?.id).
  const [chipGroupOverrides, setChipGroupOverrides] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    getGroups(language)
      .then((gs) => {
        const sorted = [...gs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setWordGroups(sorted);
      })
      .catch(() => setWordGroups([]));
  }, [language]);

  const latestGroupId = wordGroups[0]?.id ?? "";
  function getChipGroupId(chipText: string): string {
    const override = chipGroupOverrides.get(chipText);
    return override !== undefined ? override : latestGroupId;
  }
  function setChipGroupId(chipText: string, groupId: string) {
    setChipGroupOverrides((prev) => {
      const next = new Map(prev);
      next.set(chipText, groupId);
      return next;
    });
  }

  const prevExamplesLengthRef = useRef(0);
  const lastExampleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (examples.length > prevExamplesLengthRef.current) {
      lastExampleRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    prevExamplesLengthRef.current = examples.length;
  }, [examples.length]);

  useEffect(() => {
    if (language !== "chinese") return;
    const texts = [...new Set(
      examples.flatMap((ex) => {
        if (!ex.locked && ex.sentence && /[\s　]/.test(ex.sentence)) {
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
      checkTerms(language, texts)
        .then(({ existing }) => {
          if (v !== segmentVersionRef.current) return;
          setExistingTerms(new Map(Object.entries(existing)));
          setCheckingTerms(false);
        })
        .catch(() => {
          if (v === segmentVersionRef.current) setCheckingTerms(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [examples, language, refreshSignal]);

  async function handleAddSegment(chipText: string, sentence: string, translation: string) {
    if (existingTerms.has(chipText) || pendingTerms?.has(chipText)) return;
    // Per-chip group choice REPLACES the form-level `selectedGroupIds` for this
    // workflow: each chip carries exactly the group selected in its dropdown
    // (latest-created by default, or "" for no group).
    const chipGroupId = getChipGroupId(chipText);
    const groupIds = chipGroupId ? [chipGroupId] : [];
    if (onQueue) {
      onQueue(chipText, language, {
        term: chipText,
        examples: [{ sentence: sentence.replace(/[\s　]+/g, ""), translation }],
        flag: segmentFlags.get(chipText) ?? true,
        groupIds: groupIds.length > 0 ? groupIds : undefined,
      });
      return;
    }
    segmentVersionRef.current++;
    setBusySegments((prev) => new Set(prev).add(chipText));
    try {
      const { generatedWords: _gw, ...addedWord } = await smartAddWord(language, {
        term: chipText,
        examples: [{ sentence: sentence.replace(/[\s　]+/g, ""), translation }],
        flag: segmentFlags.get(chipText) ?? true,
        groupIds: groupIds.length > 0 ? groupIds : undefined,
      });
      if (groupIds.length > 0) {
        await Promise.all(
          groupIds.map((groupId) => modifyGroupMembers(language, groupId, [addedWord.id], "add"))
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

  const trimmedCurrentTerm = currentTerm?.trim() ?? "";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-sm text-gray-400">{t("examples")}</label>
        <button
          type="button"
          onClick={() =>
            setExamples([
              ...examples,
              { sentence: "", translation: "", originalTranslation: "", locked: false },
            ])
          }
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          + {t("addExample")}
        </button>
      </div>
      {examples.map((ex, i) => (
        <div
          key={i}
          ref={i === examples.length - 1 ? lastExampleRef : undefined}
          className="mb-2 rounded-lg border border-gray-600 bg-gray-700 p-2"
        >
          <input
            type="text"
            value={ex.sentence}
            onChange={(e) => {
              if (ex.locked) return;
              const next = [...examples];
              next[i] = { ...next[i], sentence: e.target.value };
              setExamples(next);
            }}
            readOnly={ex.locked}
            placeholder={language === "chinese" ? `${t("sentence")} (use spaces to split)` : t("sentence")}
            className={`mb-1 w-full rounded border border-gray-600 px-2 py-1 text-sm focus:outline-none ${
              ex.locked
                ? "cursor-not-allowed bg-gray-900 text-gray-400"
                : "bg-gray-800 text-gray-100 focus:border-blue-400"
            }`}
          />
          {language === "chinese" && !ex.locked && (() => {
            const chips = getChipInfo(ex.sentence);
            if (chips.length < 2) return null;
            const anyDeactivated = chips.some(
              (c) =>
                c.text.trim().length > 0 &&
                !/^\p{P}+$/u.test(c.text) &&
                !(trimmedCurrentTerm && c.text === trimmedCurrentTerm) &&
                !existingTerms.has(c.text) &&
                !pendingTerms?.has(c.text)
            );
            return (
              <div className="mb-1 flex flex-wrap items-start gap-1">
                {chips.map((chip, pi) => {
                  const isPunct = /^\p{P}+$/u.test(chip.text) || chip.text.trim().length === 0;
                  const isSelf = !isPunct && !!trimmedCurrentTerm && chip.text === trimmedCurrentTerm;
                  const exists = isSelf || (!isPunct && existingTerms.has(chip.text));
                  const queued = !isPunct && !isSelf && !exists && !!pendingTerms?.has(chip.text);
                  const checking = !isPunct && !isSelf && !exists && !queued && checkingTerms;
                  const busy = busySegments.has(chip.text);
                  return (
                    <Fragment key={pi}>
                      <div className="flex flex-col">
                        <button
                          type="button"
                          disabled={busy || queued || exists || checking || isPunct}
                          onClick={() => {
                            if (!exists && !queued && !checking && !isPunct) {
                              handleAddSegment(chip.text, ex.sentence, ex.translation);
                            }
                          }}
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
                        {anyDeactivated && wordGroups.length > 0 && (
                          <div className="mt-0.5 flex justify-center">
                            {!isPunct && !isSelf && !exists && !queued && !checking ? (
                              <select
                                value={getChipGroupId(chip.text)}
                                onChange={(e) => setChipGroupId(chip.text, e.target.value)}
                                disabled={busy}
                                onClick={(e) => e.stopPropagation()}
                                className="max-w-[7rem] truncate rounded border border-gray-600 bg-gray-800 px-1 py-0.5 text-[10px] text-gray-200 focus:border-blue-400 focus:outline-none disabled:opacity-50"
                                aria-label={`Group for ${chip.text}`}
                                title={`Group for ${chip.text}`}
                              >
                                <option value="">—</option>
                                {wordGroups.map((g) => (
                                  <option key={g.id} value={g.id}>
                                    {g.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="h-5" aria-hidden="true" />
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
                })}
              </div>
            );
          })()}
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
      {segmentAddError && <p className="text-xs text-red-400">{segmentAddError}</p>}
    </div>
  );
}
