import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import { analyzeImportStream, extractStreamingSentences } from "../api/import";
import { getGroups, modifyGroupMembers } from "../api/vocab";
import { getGrammarSettings } from "../api/grammar";
import GroupBSelect from "./GroupBSelect";
import {
  categoryGroups,
  latestWordGroup,
  type ImportAnalysisResult,
  type ImportExtractedGrammar,
  type ImportExtractedWord,
  type WordGroup,
} from "../types";

/** Mirrors `SmartAddPayload` in SmartAddWordModal / the word queue's create item. */
type WordQueuePayload = {
  term: string;
  transliteration?: string;
  definitions?: { partOfSpeech: string; text: Record<string, string> }[];
  topics?: string[];
  examples?: { sentence: string; translation: string; userSplits?: string[] }[];
  level?: string;
  flag?: boolean;
  groupIds?: string[];
};

/** Mirrors `GrammarPayload` (= Omit<Grammar, "language">) in useGrammarQueue. */
type GrammarQueuePayload = {
  id: string;
  statement: string;
  transliteration?: string;
  descriptions: { partOfSpeech: string; text: Record<string, string> }[];
  examples?: { sentence: string; translation: string }[];
  level?: string;
  tags?: string[];
};

interface Props {
  /** Backend full-name language (e.g. "chinese") — the language the article is in. */
  language: string;
  onQueue: (term: string, language: string, payload: WordQueuePayload) => void;
  onGrammarQueue: (
    statement: string,
    language: string,
    payload: GrammarQueuePayload,
    opts?: { groupNames?: string[]; groupIds?: string[]; draftId?: string }
  ) => void;
  onBack: () => void;
}

type Phase = "input" | "analyzing" | "review";

export default function ImportView({ language, onQueue, onGrammarQueue, onBack }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("input");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [wordGroups, setWordGroups] = useState<WordGroup[]>([]);
  const [targetGroupId, setTargetGroupId] = useState("");
  const [wordGroupBIds, setWordGroupBIds] = useState<string[]>([]);
  const [grammarGroupBIds, setGrammarGroupBIds] = useState<string[]>([]);
  const [defaultDescLang, setDefaultDescLang] = useState("ja");

  const [streamText, setStreamText] = useState("");
  const [analysis, setAnalysis] = useState<ImportAnalysisResult | null>(null);
  const [existing, setExisting] = useState<Record<string, string>>({});
  const [excludedWords, setExcludedWords] = useState<Set<string>>(new Set());
  const [excludedGrammar, setExcludedGrammar] = useState<Set<number>>(new Set());
  const [registered, setRegistered] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getGroups(language)
      .then((gs) => {
        const aGroups = categoryGroups(gs, "A");
        setWordGroups(aGroups);
        setTargetGroupId(latestWordGroup(aGroups)?.id ?? "");
      })
      .catch(() => setWordGroups([]));
  }, [language]);

  useEffect(() => {
    getGrammarSettings()
      .then((s) => { if (s?.defaultDefinitionLanguage) setDefaultDescLang(s.defaultDefinitionLanguage); })
      .catch(() => {});
  }, []);

  // Cancel an in-flight analysis if the view unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const sentenceByIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of analysis?.paragraphs ?? []) {
      for (const s of p.sentences) map.set(s.index, s.text);
    }
    return map;
  }, [analysis]);

  async function handleAnalyze() {
    if (!text.trim()) return;
    setError(null);
    setStreamText("");
    setAnalysis(null);
    setExisting({});
    setExcludedWords(new Set());
    setExcludedGrammar(new Set());
    setRegistered(false);
    setPhase("analyzing");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await analyzeImportStream(
        language,
        text.trim(),
        {
          onDelta: setStreamText,
          onResult: (result, existingMap) => {
            setAnalysis(result);
            setExisting(existingMap);
            setPhase("review");
          },
          onError: (err) => {
            setError(err.message);
            setPhase("input");
          },
        },
        controller.signal
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("input");
    } finally {
      abortRef.current = null;
    }
  }

  function cancelAnalysis() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("input");
  }

  function handleRegister() {
    if (!analysis || registered) return;
    const groupIds = [...new Set([...(targetGroupId ? [targetGroupId] : []), ...wordGroupBIds])];

    // New words go through the normal word queue: smart-add enriches them and the
    // occurrence sentence becomes the example (empty translation is LLM-filled
    // server-side). Failures are auto-rescued into drafts by the queue.
    const existingIdsToAdd: string[] = [];
    for (const w of analysis.words) {
      const term = w.term.trim();
      if (!term || excludedWords.has(term)) continue;
      const sentence = sentenceByIndex.get(w.sentenceIndex) ?? "";
      if (existing[term]) {
        // Already in the DB: only extend Group B membership, never touch Group A.
        existingIdsToAdd.push(existing[term]);
        continue;
      }
      const payload: WordQueuePayload = {
        term,
        ...(w.transliteration?.trim() ? { transliteration: w.transliteration.trim() } : {}),
        ...(sentence ? { examples: [{ sentence, translation: "" }] } : {}),
        ...(groupIds.length > 0 ? { groupIds } : {}),
      };
      onQueue(term, language, payload);
    }

    if (existingIdsToAdd.length > 0 && wordGroupBIds.length > 0) {
      for (const gid of wordGroupBIds) {
        modifyGroupMembers(language, gid, [...new Set(existingIdsToAdd)], "add").catch(() => {});
      }
    }

    // Grammar: always created fresh — duplicate detection is intentionally absent.
    analysis.grammar.forEach((g, i) => {
      if (excludedGrammar.has(i)) return;
      const sentence = sentenceByIndex.get(g.sentenceIndex) ?? "";
      const payload: GrammarQueuePayload = {
        id: `grammar-${language}-${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        statement: g.statement.trim(),
        descriptions: [{ partOfSpeech: "", text: { [defaultDescLang]: g.description ?? "" } }],
        ...(sentence ? { examples: [{ sentence, translation: "" }] } : {}),
      };
      onGrammarQueue(
        g.statement.trim(),
        language,
        payload,
        grammarGroupBIds.length > 0 ? { groupIds: grammarGroupBIds } : undefined
      );
    });

    setRegistered(true);
  }

  function toggleWord(term: string) {
    setExcludedWords((prev) => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term);
      else next.add(term);
      return next;
    });
  }

  function toggleGrammar(i: number) {
    setExcludedGrammar((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // ===== INPUT =====
  if (phase === "input") {
    return (
      <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-100">{t("importTitle")}</h2>
          <button onClick={onBack} className="text-sm text-gray-400 hover:text-gray-200">
            {t("cancel")}
          </button>
        </div>
        <p className="text-sm text-gray-400">{t("importDescription")}</p>

        {error && (
          <p className="rounded-lg border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={8000}
          rows={14}
          className="w-full resize-y rounded-lg border border-gray-600 bg-gray-800 px-4 py-3 text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
        />
        <p className="text-right text-xs text-gray-500">{text.length} / 8000</p>

        <div>
          <label className="mb-1 block text-sm text-gray-400">{t("importTargetGroup")}</label>
          <select
            value={targetGroupId}
            onChange={(e) => setTargetGroupId(e.target.value)}
            className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-100"
          >
            <option value="">{t("noGroupOption")}</option>
            {wordGroups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>

        <GroupBSelect
          kind="word"
          language={language}
          selectedIds={wordGroupBIds}
          onChange={setWordGroupBIds}
          label="Group B (words)"
        />
        <GroupBSelect
          kind="grammar"
          language={language}
          selectedIds={grammarGroupBIds}
          onChange={setGrammarGroupBIds}
          label="Group B (grammar)"
        />

        <button
          onClick={handleAnalyze}
          disabled={!text.trim()}
          className="w-full rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("importAnalyze")}
        </button>
      </div>
    );
  }

  // ===== ANALYZING =====
  if (phase === "analyzing") {
    const sentences = extractStreamingSentences(streamText);
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
          <span className="text-sm text-gray-300">{t("importAnalyzing")}</span>
          <button onClick={cancelAnalysis} className="ml-auto text-sm text-gray-400 hover:text-gray-200">
            {t("cancel")}
          </button>
        </div>
        <div className="space-y-1.5">
          {sentences.map((s, i) => (
            <p key={i} className="text-sm text-gray-300">{s}</p>
          ))}
        </div>
      </div>
    );
  }

  // ===== REVIEW =====
  const words = analysis?.words ?? [];
  const grammar = analysis?.grammar ?? [];
  const nothing = words.length === 0 && grammar.length === 0;

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-100">{t("importReview")}</h2>
        <button onClick={onBack} className="text-sm text-gray-400 hover:text-gray-200">
          {t("cancel")}
        </button>
      </div>

      {nothing && <p className="text-sm text-gray-400">{t("importNoResults")}</p>}

      {words.length > 0 && (
        <section className="rounded-xl border border-blue-900/60 bg-gray-800/60 p-3">
          <h3 className="mb-2 text-sm font-semibold text-blue-300">
            {t("words")} ({words.length})
          </h3>
          <ul className="space-y-1.5">
            {words.map((w: ImportExtractedWord) => {
              const term = w.term.trim();
              const isExisting = !!existing[term];
              return (
                <li key={term} className="flex items-start gap-2 rounded-lg bg-gray-900/40 px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={!excludedWords.has(term)}
                    onChange={() => toggleWord(term)}
                    className="mt-1 h-4 w-4 accent-indigo-500"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-gray-100">
                      <span className="font-medium">{term}</span>
                      {w.transliteration && <span className="text-xs text-gray-500">{w.transliteration}</span>}
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                          isExisting
                            ? "border border-green-700/50 bg-green-950/40 text-green-300"
                            : "border border-blue-700/50 bg-blue-950/40 text-blue-300"
                        }`}
                      >
                        {isExisting ? t("importExisting") : t("importNew")}
                      </span>
                    </p>
                    {w.meaning && <p className="text-xs text-gray-400">{w.meaning}</p>}
                    {!isExisting && (
                      <p className="mt-0.5 text-xs text-gray-500">
                        {sentenceByIndex.get(w.sentenceIndex)}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {grammar.length > 0 && (
        <section className="rounded-xl border border-purple-900/60 bg-gray-800/60 p-3">
          <h3 className="mb-2 text-sm font-semibold text-purple-300">
            {t("sectionGrammar")} ({grammar.length})
          </h3>
          <ul className="space-y-1.5">
            {grammar.map((g: ImportExtractedGrammar, i: number) => (
              <li key={i} className="flex items-start gap-2 rounded-lg bg-gray-900/40 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={!excludedGrammar.has(i)}
                  onChange={() => toggleGrammar(i)}
                  className="mt-1 h-4 w-4 accent-indigo-500"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-100">{g.statement}</p>
                  <p className="text-xs text-gray-400">{g.description}</p>
                  <p className="mt-0.5 text-xs text-gray-500">{sentenceByIndex.get(g.sentenceIndex)}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {registered ? (
        <div className="space-y-2">
          <p className="rounded-lg border border-green-700 bg-green-950/30 px-3 py-2 text-sm text-green-300">
            ✓ {t("importRegister")}
          </p>
          <p className="text-xs text-gray-500">{t("importFailuresSaved")}</p>
          <button
            onClick={onBack}
            className="w-full rounded-lg bg-gray-700 px-5 py-2.5 text-sm text-gray-200 hover:bg-gray-600"
          >
            {t("back")}
          </button>
        </div>
      ) : (
        <button
          onClick={handleRegister}
          disabled={nothing}
          className="w-full rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {t("importRegister")}
        </button>
      )}
    </div>
  );
}
