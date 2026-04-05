import { useState, useEffect, useRef, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { ALL_KNOWN_LANGUAGES } from "../settings/defaults";
import { translateStream, getTranslationHistory, deleteTranslationHistory } from "../api/translation";
import type { TranslationEntry, TranslationResult, SentenceAnalysis, SentenceAnalysisResult, AnalysisChunk } from "../types";

interface Props {
  mode: "new" | "resume";
}

export default function TranslationView({ mode }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const KNOWN_LANGUAGES = useMemo(
    () => settings.languageOrder
      .map((code) => ALL_KNOWN_LANGUAGES.find((l) => l.code === code))
      .filter(Boolean)
      .map((l) => ({ code: l!.code, label: l!.nativeLabel })),
    [settings.languageOrder],
  );
  const [history, setHistory] = useState<TranslationEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [phase, setPhase] = useState<"input" | "loading" | "results">("input");
  const [inputText, setInputText] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState<string>(KNOWN_LANGUAGES[0]?.code ?? "en");
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([settings.languageOrder[0] ?? "ja"]);
  const [activeTab, setActiveTab] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [decomposeChunks, setDecomposeChunks] = useState<string>("");
  const [decomposeComplete, setDecomposeComplete] = useState(false);
  const [streamingChunks, setStreamingChunks] = useState<Map<string, string>>(new Map());
  const [streamResults, setStreamResults] = useState<Map<string, TranslationResult>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastInputRef = useRef("");
  const lastSourceLangRef = useRef<string>(KNOWN_LANGUAGES[0]?.code ?? "en");
  const lastLangsRef = useRef<string[]>([]);
  const doneRef = useRef(false);
  const needsCleanupRef = useRef(mode === "new");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (mode === "new") {
          if (!cancelled) setLoadingHistory(false);
          return;
        }
        const { entries } = await getTranslationHistory(1, 50);
        if (!cancelled) {
          setHistory(entries);
          if (entries.length > 0) {
            setHistoryIndex(0);
            setPhase("results");
            setActiveTab(0);
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  function handleSourceLanguageChange(code: string) {
    setSourceLanguage(code);
    setSelectedLanguages((prev) => prev.filter((l) => l !== code));
  }

  function toggleLanguage(code: string) {
    setSelectedLanguages((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code]
    );
  }

  function getTargetLanguages(): string[] {
    return selectedLanguages.filter((l) => l !== sourceLanguage);
  }

  const canSubmit = inputText.trim().length > 0 && getTargetLanguages().length > 0;

  async function handleTranslate() {
    if (!canSubmit) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastInputRef.current = inputText.trim();
    lastSourceLangRef.current = sourceLanguage;
    lastLangsRef.current = getTargetLanguages();
    doneRef.current = false;
    setError(null);
    setPhase("loading");
    setDecomposeChunks("");
    setDecomposeComplete(false);
    setStreamingChunks(new Map());
    setStreamResults(new Map());

    const didCleanup = needsCleanupRef.current;
    if (needsCleanupRef.current) {
      needsCleanupRef.current = false;
      deleteTranslationHistory().catch(() => {});
    }

    try {
      await translateStream(sourceLanguage, inputText.trim(), getTargetLanguages(), {
        onDecomposeChunk(chunk) {
          setDecomposeChunks((prev) => prev + chunk);
        },
        onDecomposeResult() {
          setDecomposeComplete(true);
        },
        onStart(language) {
          setStreamingChunks((prev) => {
            const next = new Map(prev);
            next.set(language, "");
            return next;
          });
        },
        onChunk(language, chunk) {
          setStreamingChunks((prev) => {
            const next = new Map(prev);
            next.set(language, (next.get(language) ?? "") + chunk);
            return next;
          });
        },
        onResult(language, result) {
          setStreamResults((prev) => {
            const next = new Map(prev);
            next.set(language, result);
            return next;
          });
          setStreamingChunks((prev) => {
            const next = new Map(prev);
            next.delete(language);
            return next;
          });
        },
        onDone(entry) {
          doneRef.current = true;
          if (didCleanup) {
            setHistory([entry]);
          } else {
            setHistory((prev) => [entry, ...prev]);
          }
          setHistoryIndex(0);
          setActiveTab(0);
          setPhase("results");
          setInputText("");
          setStreamingChunks(new Map());
          setStreamResults(new Map());
        },
        onError(err) {
          setError(err.message);
          setStreamingChunks(new Map());
          setDecomposeChunks("");
        },
      }, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("Translation failed:", err);
      setError(String(err));
      setStreamingChunks(new Map());
      setDecomposeChunks("");
    }
  }

  // Transition to results when all languages have results (for per-language regeneration)
  useEffect(() => {
    if (phase !== "loading" || doneRef.current) return;
    const langs = lastLangsRef.current;
    if (langs.length === 0) return;
    if (!langs.every((l) => streamResults.has(l))) return;

    doneRef.current = true;
    const results = langs.map((l) => streamResults.get(l)!);
    const entry: TranslationEntry = {
      id: `local-${Date.now()}`,
      sourceLanguage: lastSourceLangRef.current,
      sourceText: lastInputRef.current,
      targetLanguages: langs,
      results,
      createdAt: new Date().toISOString(),
    };
    setHistory((prev) => [entry, ...prev]);
    setHistoryIndex(0);
    setActiveTab(0);
    setPhase("results");
    setInputText("");
    setStreamingChunks(new Map());
    setStreamResults(new Map());
  }, [streamResults, phase]);

  async function handleRegenerateLang(lang: string) {
    // Abort the main stream (it may be hung)
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    // Reset state for this language
    setStreamingChunks((prev) => {
      const next = new Map(prev);
      next.set(lang, "");
      return next;
    });
    setStreamResults((prev) => {
      const next = new Map(prev);
      next.delete(lang);
      return next;
    });

    try {
      await translateStream(lastSourceLangRef.current, lastInputRef.current, [lang], {
        onChunk(_language, chunk) {
          setStreamingChunks((prev) => {
            const next = new Map(prev);
            next.set(lang, (prev.get(lang) ?? "") + chunk);
            return next;
          });
        },
        onResult(_language, result) {
          setStreamResults((prev) => {
            const next = new Map(prev);
            next.set(lang, result);
            return next;
          });
          setStreamingChunks((prev) => {
            const next = new Map(prev);
            next.delete(lang);
            return next;
          });
        },
      }, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error(`Regenerate ${lang} failed:`, err);
    }
    setStreamingChunks((prev) => {
      const next = new Map(prev);
      next.delete(lang);
      return next;
    });
  }

  function handleNewTranslation() {
    setPhase("input");
    setInputText("");
    setActiveTab(0);
  }

  function handleRegenerateTranslation() {
    if (!currentEntry) return;
    setSourceLanguage(currentEntry.sourceLanguage ?? sourceLanguage);
    setInputText(currentEntry.sourceText);
    setSelectedLanguages(currentEntry.targetLanguages);
    setPhase("input");
    setError(null);
  }

  function handlePrevious() {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setActiveTab(0);
    }
  }

  function handleNext() {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setActiveTab(0);
    }
  }

  const currentEntry = history[historyIndex] ?? null;

  if (loadingHistory) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-violet-400 border-t-transparent" />
      </div>
    );
  }

  const hasTranslationNav = history.length > 0;

  function TranslationNavBar() {
    if (!hasTranslationNav) return null;
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <button
          onClick={() => { setHistoryIndex(0); setActiveTab(0); setPhase("results"); }}
          className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
        >
          {t("previous")}
        </button>
      </div>
    );
  }

  // ===== INPUT PHASE =====
  if (phase === "input") {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-5">
        <h2 className="text-lg font-bold text-gray-100">{t("sectionTranslation")}</h2>

        {phase === "input" && <TranslationNavBar />}

        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={t("enterTextPlaceholder")}
          className="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-3 text-gray-100 placeholder-gray-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-y"
          rows={4}
        />

        <div>
          <p className="mb-2 text-sm font-medium text-gray-400">{t("sourceLanguageLabel")}</p>
          <div className="flex flex-wrap gap-2">
            {KNOWN_LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => handleSourceLanguageChange(lang.code)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  sourceLanguage === lang.code
                    ? "bg-cyan-600 text-white"
                    : "border border-gray-600 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-400">{t("targetLanguagesLabel")}</p>
          <div className="flex flex-wrap gap-2">
            {KNOWN_LANGUAGES.filter((lang) => lang.code !== sourceLanguage).map((lang) => (
              <button
                key={lang.code}
                onClick={() => toggleLanguage(lang.code)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  selectedLanguages.includes(lang.code)
                    ? "bg-violet-600 text-white"
                    : "border border-gray-600 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleTranslate}
          disabled={!canSubmit}
          className={`w-full rounded-lg px-5 py-3 font-medium text-white transition-colors ${
            canSubmit
              ? "bg-violet-600 hover:bg-violet-500"
              : "cursor-not-allowed bg-violet-600/40 text-white/50"
          }`}
        >
          {t("translateAnalyze")}
        </button>
      </div>
    );
  }

  // ===== LOADING PHASE =====
  if (phase === "loading") {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-4">
        <h2 className="text-lg font-bold text-gray-100">{t("translating")}</h2>
        <TranslationNavBar />

        {error && (
          <div className="rounded-lg bg-red-900/30 border border-red-700 p-4 space-y-3">
            <p className="text-sm text-red-300">{error}</p>
            <div className="flex gap-2">
              <button
                onClick={handleTranslate}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 transition-colors"
              >
                {t("regenerate")}
              </button>
              <button
                onClick={() => { setError(null); setPhase("input"); }}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
              >
                {t("back")}
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Decomposition */}
        {!error && (
          <div className="rounded-lg bg-gray-800/60 p-4">
            <div className="flex items-center gap-2 mb-2">
              {decomposeComplete ? (
                <span className="text-green-400 text-xs">&#10003;</span>
              ) : (
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
              )}
              <p className="text-xs text-violet-400 font-semibold">
                {decomposeComplete ? t("decompositionComplete") : t("analyzingStructure")}
              </p>
            </div>
            {decomposeChunks && !decomposeComplete && (
              <p className="text-sm text-gray-400 font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {decomposeChunks.slice(-500)}
              </p>
            )}
          </div>
        )}

        {/* Step 2: Per-language translation */}
        {!error && getTargetLanguages().map((lang) => {
          const knownLang = KNOWN_LANGUAGES.find((l) => l.code === lang);
          const label = knownLang?.label ?? lang;
          const completed = streamResults.get(lang);
          const chunks = streamingChunks.get(lang);
          const isStreaming = chunks !== undefined && !completed;

          if (completed) {
            // Completed
            return (
              <div key={lang} className="rounded-lg bg-gray-800/60 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-green-400 text-xs">&#10003;</span>
                  <p className="text-xs text-violet-400 font-semibold">{label}</p>
                </div>
                {completed.analysis && (
                  <p className="text-sm text-gray-300">
                    {completed.analysis.sentences.map((s) => s.text).join(" ")}
                  </p>
                )}
              </div>
            );
          }

          if (isStreaming) {
            // Actively streaming
            return (
              <div key={lang} className="rounded-lg bg-gray-800/60 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
                  <p className="text-xs text-violet-400 font-semibold">{label}</p>
                </div>
                {chunks && (
                  <p className="text-sm text-gray-400 font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                    {chunks.slice(-500)}
                  </p>
                )}
                <button
                  onClick={() => handleRegenerateLang(lang)}
                  className="mt-2 rounded-md border border-gray-600 px-3 py-1 text-xs text-gray-400 hover:bg-gray-700 transition-colors"
                >
                  {t("regenerate")}
                </button>
              </div>
            );
          }

          // Not started yet
          return (
            <div key={lang} className="rounded-lg bg-gray-800/30 p-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  {label} — waiting...
                </p>
                <button
                  onClick={() => handleRegenerateLang(lang)}
                  className="rounded-md border border-gray-600 px-3 py-1 text-xs text-gray-400 hover:bg-gray-700 transition-colors"
                >
                  {t("regenerate")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ===== RESULTS PHASE =====
  if (!currentEntry) {
    setPhase("input");
    return null;
  }

  const result = currentEntry.results[activeTab];

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-4">
      {/* Navigation */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleNewTranslation}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 transition-colors"
        >
          {t("newTranslation")}
        </button>
        <button
          onClick={handleRegenerateTranslation}
          className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
        >
          {t("regenerate")}
        </button>
        <div className="flex-1" />
        {historyIndex < history.length - 1 && (
          <button
            onClick={handlePrevious}
            className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t("previous")}
          </button>
        )}
        {historyIndex > 0 && (
          <button
            onClick={handleNext}
            className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t("next")}
          </button>
        )}
      </div>

      {/* Source text */}
      <div className="rounded-lg bg-gray-800/60 p-4">
        <p className="text-sm text-gray-400 mb-1">Source</p>
        <p className="text-gray-100">{currentEntry.sourceText}</p>
      </div>

      {/* Language tabs */}
      {currentEntry.results.length > 1 && (
        <div className="flex gap-1 rounded-lg bg-gray-800/40 p-1">
          {currentEntry.results.map((r, i) => {
            const knownLang = KNOWN_LANGUAGES.find((l) => l.code === r.language);
            const label = knownLang?.label ?? r.language;
            return (
              <button
                key={r.language}
                onClick={() => setActiveTab(i)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === i
                    ? "bg-violet-600 text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Result content */}
      {result && (
        <div className="space-y-4">
          {result.error ? (
            <div className="rounded-lg bg-red-900/30 border border-red-700 p-4">
              <p className="text-red-300">{t("translationError")}</p>
              <p className="mt-1 text-sm text-red-400">{result.error}</p>
            </div>
          ) : result.analysis ? (
            <AnalysisView analysis={result.analysis} />
          ) : null}
        </div>
      )}

      {/* History position indicator */}
      {history.length > 1 && (
        <p className="text-center text-xs text-gray-500">
          {history.length - historyIndex} / {history.length}
        </p>
      )}
    </div>
  );
}

const CJK_REGEX = /[\u3000-\u9fff\uf900-\ufaff]/;

function ComponentTable({ components, showReading }: { components: import("../types").AnalysisComponent[]; showReading: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-700 text-gray-500">
            <th className="text-left py-1 pr-3">Surface</th>
            {showReading && <th className="text-left py-1 pr-3">Reading</th>}
            <th className="text-left py-1 pr-3">Base Form</th>
            <th className="text-left py-1 pr-3">POS</th>
            <th className="text-left py-1 pr-3">Meaning</th>
            <th className="text-left py-1">Explanation</th>
          </tr>
        </thead>
        <tbody>
          {components.map((comp) => (
            <tr key={comp.componentId} className="border-b border-gray-800">
              <td className="py-1.5 pr-3 font-medium text-gray-200">{comp.surface}</td>
              {showReading && <td className="py-1.5 pr-3 text-gray-400">{comp.reading ?? "—"}</td>}
              <td className="py-1.5 pr-3 text-gray-400">{comp.baseForm ?? "—"}</td>
              <td className="py-1.5 pr-3">
                <span className="rounded bg-gray-700 px-1 py-0.5 text-gray-300">{comp.partOfSpeech}</span>
              </td>
              <td className="py-1.5 pr-3 text-gray-300">{comp.meaning}</td>
              <td className="py-1.5 text-gray-400">{comp.explanation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChunkRow({ chunk, showReading }: { chunk: AnalysisChunk; showReading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-gray-700/50 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full py-2.5 px-3 text-left hover:bg-gray-700/30 transition-colors rounded-md"
      >
        <span className={`text-gray-500 text-xs transition-transform ${expanded ? "rotate-90" : ""}`}>&#9654;</span>
        <span className="text-sm font-medium text-gray-200">{chunk.surface}</span>
        <span className="text-sm text-gray-500 ml-auto">{chunk.meaning}</span>
      </button>
      {expanded && (
        <div className="pl-6 pb-3 pr-3">
          <ComponentTable components={chunk.components} showReading={showReading} />
        </div>
      )}
    </div>
  );
}

function SentenceCard({ sentence }: { sentence: SentenceAnalysis }) {
  const allComponents = sentence.chunks?.length
    ? sentence.chunks.flatMap((ch) => ch.components)
    : sentence.components ?? [];
  const showReading = allComponents.some((c) => CJK_REGEX.test(c.surface));

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-gray-800/60 p-4">
        <p className="text-gray-100 font-medium">{sentence.text}</p>
        {sentence.meaning && (
          <p className="text-gray-400 text-sm mt-1">{sentence.meaning}</p>
        )}
      </div>

      {sentence.chunks?.length ? (
        <div className="rounded-lg bg-gray-800/60 p-2">
          {sentence.chunks.map((chunk) => (
            <ChunkRow key={chunk.chunkId} chunk={chunk} showReading={showReading} />
          ))}
        </div>
      ) : allComponents.length > 0 ? (
        <div className="rounded-lg bg-gray-800/60 p-4 overflow-x-auto">
          <ComponentTable components={allComponents} showReading={showReading} />
        </div>
      ) : null}
    </div>
  );
}

function AnalysisView({ analysis }: { analysis: SentenceAnalysisResult }) {
  return (
    <div className="space-y-6">
      {analysis.sentences.map((sentence) => (
        <SentenceCard key={sentence.sentenceId} sentence={sentence} />
      ))}
    </div>
  );
}
