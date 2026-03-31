import { useState, useEffect, useMemo, useRef } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { ALL_KNOWN_LANGUAGES } from "../settings/defaults";
import { submitCorrectionStream, getSpeakingWritingSession, deleteSpeakingWritingSession } from "../api/speaking-writing";
import type { SpeakingWritingSession, SentenceCorrection, CorrectionItem } from "../types";

interface Props {
  mode: "new" | "resume";
}

export default function SpeakingWritingView({ mode }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const KNOWN_LANGUAGES = useMemo(
    () => settings.languageOrder
      .map((code) => ALL_KNOWN_LANGUAGES.find((l) => l.code === code))
      .filter(Boolean)
      .map((l) => ({ code: l!.code, label: l!.nativeLabel })),
    [settings.languageOrder],
  );

  const SPEAKING_USE_CASES = [
    { key: "professional", label: t("useCaseProfessional") },
    { key: "casual", label: t("useCaseCasual") },
    { key: "presentation", label: t("useCasePresentation") },
    { key: "interview", label: t("useCaseInterview") },
  ];
  const WRITING_USE_CASES = [
    { key: "academic", label: t("useCaseAcademic") },
    { key: "social", label: t("useCaseSocial") },
    { key: "email", label: t("useCaseEmail") },
    { key: "creative", label: t("useCaseCreative") },
  ];

  const [phase, setPhase] = useState<"input" | "loading" | "results">("input");
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(settings.languageOrder[0] ?? "en");
  const [selectedMode, setSelectedMode] = useState<"speaking" | "writing">("speaking");
  const [selectedUseCase, setSelectedUseCase] = useState("professional");
  const [inputText, setInputText] = useState("");
  const [session, setSession] = useState<SpeakingWritingSession | null>(null);
  const [correctionIndex, setCorrectionIndex] = useState(0);
  const [loadingSession, setLoadingSession] = useState(mode === "resume");
  const [error, setError] = useState<string | null>(null);
  const [streamingChunks, setStreamingChunks] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const needsCleanupRef = useRef(mode === "new");

  const LANG_CODES = ["en", "ja", "ko", "zh"];

  // Resume: find existing session
  useEffect(() => {
    if (mode !== "resume") return;
    let cancelled = false;
    (async () => {
      try {
        for (const code of LANG_CODES) {
          const sess = await getSpeakingWritingSession(code);
          if (sess && sess.corrections.length > 0) {
            if (!cancelled) {
              setSession(sess);
              setSelectedLanguage(sess.language);
              setSelectedMode(sess.mode);
              setSelectedUseCase(sess.useCase || (sess.mode === "speaking" ? "professional" : "academic"));
              setCorrectionIndex(sess.currentIndex);
              setPhase("results");
            }
            return;
          }
        }
        // No session found, fall back to input
        if (!cancelled) setPhase("input");
      } catch {
        if (!cancelled) setPhase("input");
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  const canSubmit = inputText.trim().length > 0 && selectedLanguage;

  async function handleSubmit() {
    if (!canSubmit || !selectedLanguage) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setStreamingChunks("");
    setPhase("loading");

    if (needsCleanupRef.current) {
      needsCleanupRef.current = false;
      for (const code of LANG_CODES) {
        await deleteSpeakingWritingSession(code).catch(() => {});
      }
    }
    let settled = false;
    try {
      await submitCorrectionStream(
        selectedLanguage,
        selectedMode,
        selectedUseCase,
        inputText.trim(),
        {
          onChunk(chunk) {
            setStreamingChunks((prev) => prev + chunk);
          },
          onDone(updatedSession) {
            settled = true;
            setSession(updatedSession);
            setCorrectionIndex(updatedSession.corrections.length - 1);
            setInputText("");
            setStreamingChunks("");
            setPhase("results");
          },
          onError(message) {
            settled = true;
            setError(message);
            setStreamingChunks("");
          },
        },
        controller.signal,
      );
      if (!settled && !controller.signal.aborted) {
        setError("Correction failed: connection closed unexpectedly");
        setStreamingChunks("");
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("Correction failed:", err);
      setError(String(err));
      setStreamingChunks("");
    }
  }

  function handleNewCorrection() {
    setPhase("input");
    setInputText("");
    setError(null);
  }

  function handleRegenerate() {
    if (!session || !session.corrections[correctionIndex]) return;
    const entry = session.corrections[correctionIndex];
    setInputText(entry.inputText);
    setPhase("input");
    setError(null);
  }

  function handlePrevious() {
    if (correctionIndex > 0) {
      setCorrectionIndex(correctionIndex - 1);
      if (phase !== "results") setPhase("results");
    }
  }

  function handleNext() {
    if (session && correctionIndex < session.corrections.length - 1) {
      setCorrectionIndex(correctionIndex + 1);
      if (phase !== "results") setPhase("results");
    }
  }

  const hasPrevious = session !== null && correctionIndex > 0;
  const hasNext = session !== null && correctionIndex < (session.corrections.length ?? 0) - 1;
  const hasHistory = session !== null && session.corrections.length > 0;

  if (loadingSession) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-teal-400 border-t-transparent" />
      </div>
    );
  }

  // Shared navigation bar — shown in input/loading phases when history exists
  function NavigationBar() {
    if (phase === "results" || !hasHistory) return null;
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <button
          onClick={() => { setCorrectionIndex((session?.corrections.length ?? 1) - 1); setPhase("results"); }}
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
        <h2 className="text-lg font-bold text-gray-100">{t("sectionSpeakingWriting")}</h2>

        <NavigationBar />

        {/* Language selector */}
        <div>
          <p className="mb-2 text-sm font-medium text-gray-400">{t("swSelectLanguage")}</p>
          <div className="flex flex-wrap gap-2">
            {KNOWN_LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => setSelectedLanguage(lang.code)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  selectedLanguage === lang.code
                    ? "bg-teal-600 text-white"
                    : "border border-gray-600 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>

        {/* Speaking / Writing mode toggle */}
        <div>
          <div className="flex gap-2">
            <button
              onClick={() => { setSelectedMode("speaking"); setSelectedUseCase("professional"); }}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                selectedMode === "speaking"
                  ? "bg-teal-600 text-white"
                  : "border border-gray-600 text-gray-400 hover:bg-gray-700"
              }`}
            >
              {t("modeSpeaking")}
            </button>
            <button
              onClick={() => { setSelectedMode("writing"); setSelectedUseCase("academic"); }}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                selectedMode === "writing"
                  ? "bg-teal-600 text-white"
                  : "border border-gray-600 text-gray-400 hover:bg-gray-700"
              }`}
            >
              {t("modeWriting")}
            </button>
          </div>
        </div>

        {/* Use case selector */}
        <div className="flex flex-wrap gap-2">
          {(selectedMode === "speaking" ? SPEAKING_USE_CASES : WRITING_USE_CASES).map((uc) => (
            <button
              key={uc.key}
              onClick={() => setSelectedUseCase(uc.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                selectedUseCase === uc.key
                  ? "bg-teal-700 text-teal-100 border border-teal-500"
                  : "border border-gray-600 text-gray-400 hover:bg-gray-700"
              }`}
            >
              {uc.label}
            </button>
          ))}
        </div>

        {/* Input text */}
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={t("swInputPlaceholder")}
          className="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-3 text-gray-100 placeholder-gray-500 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 resize-y"
          rows={5}
        />

        {error && (
          <div className="rounded-lg bg-red-900/30 border border-red-700 p-3">
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`w-full rounded-lg px-5 py-3 font-medium text-white transition-colors ${
            canSubmit
              ? "bg-teal-600 hover:bg-teal-500"
              : "cursor-not-allowed bg-teal-600/40 text-white/50"
          }`}
        >
          {t("startCorrection")}
        </button>
      </div>
    );
  }

  // ===== LOADING PHASE =====
  if (phase === "loading") {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-4">
        <h2 className="text-lg font-bold text-gray-100">{t("sectionSpeakingWriting")}</h2>
        <NavigationBar />
        {error ? (
          <div className="rounded-lg bg-red-900/30 border border-red-700 p-4 space-y-3">
            <p className="text-sm text-red-300">{error}</p>
            <div className="flex gap-2">
              <button
                onClick={handleSubmit}
                className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 transition-colors"
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
        ) : (
          <div className="rounded-lg bg-gray-800/60 p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-teal-400 border-t-transparent" />
              <p className="text-xs text-teal-400 font-semibold">{t("correcting")}</p>
            </div>
            {streamingChunks && (
              <p className="text-sm text-gray-400 font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                {streamingChunks.slice(-800)}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  // ===== RESULTS PHASE =====
  if (!session || session.corrections.length === 0) {
    setPhase("input");
    return null;
  }

  const entry = session.corrections[correctionIndex];
  if (!entry) {
    setPhase("input");
    return null;
  }

  const { result } = entry;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-4">
      {/* Navigation */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleNewCorrection}
          className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 transition-colors"
        >
          {t("newCorrection")}
        </button>
        <button
          onClick={handleRegenerate}
          className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
        >
          {t("regenerate")}
        </button>
        <div className="flex-1" />
        {hasPrevious && (
          <button
            onClick={handlePrevious}
            className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t("previous")}
          </button>
        )}
        {hasNext && (
          <button
            onClick={handleNext}
            className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t("next")}
          </button>
        )}
      </div>

      {/* Per-sentence corrections */}
      {result.sentences.map((sentence, i) => (
        <SentenceCorrectionCard key={i} sentence={sentence} index={i} />
      ))}

      {/* Overall feedback */}
      <div className="rounded-lg bg-gray-800/60 p-4">
        <p className="text-sm text-teal-400 mb-1 font-semibold">{t("overallFeedback")}</p>
        <p className="text-sm text-gray-300 whitespace-pre-wrap">{result.overallFeedback}</p>
      </div>

      {/* Position indicator */}
      {session.corrections.length > 1 && (
        <p className="text-center text-xs text-gray-500">
          {correctionIndex + 1} / {session.corrections.length}
        </p>
      )}
    </div>
  );
}

function SentenceCorrectionCard({ sentence, index }: { sentence: SentenceCorrection; index: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasCorrections = sentence.corrections.length > 0;

  return (
    <div className="space-y-3">
      {/* Original + corrected sentence — clickable to expand corrections */}
      <div
        onClick={() => {
          if (window.getSelection()?.toString()) return;
          hasCorrections && setOpen((v) => !v);
        }}
        className={`w-full rounded-lg bg-gray-800/60 p-4 text-left transition-colors ${hasCorrections ? "cursor-pointer hover:bg-gray-800/80" : "cursor-default"}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p className="text-xs text-gray-500 mb-1">{t("originalText")} #{index + 1}</p>
              <p className="text-gray-100 whitespace-pre-wrap">{sentence.original}</p>
            </div>
            <div className="rounded-md bg-teal-900/30 border border-teal-700 p-3">
              <p className="text-xs text-teal-400 mb-1 font-semibold">{t("overallCorrectedText")}</p>
              <p className="text-gray-100 whitespace-pre-wrap">{sentence.corrected}</p>
            </div>
          </div>
          {hasCorrections && (
            <span className={`mt-1 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}>
              &#9662;
            </span>
          )}
        </div>
      </div>

      {/* Individual corrections — shown when expanded */}
      {open && hasCorrections && (
        <div className="space-y-2 pl-2 border-l-2 border-gray-700">
          {sentence.corrections.map((correction, i) => (
            <CorrectionCard key={i} correction={correction} />
          ))}
        </div>
      )}
    </div>
  );
}

function CorrectionCard({ correction }: { correction: CorrectionItem }) {
  const { t } = useI18n();

  const severityConfig = {
    error: { label: t("severityError"), bg: "bg-red-900/40", border: "border-red-700", badge: "bg-red-700 text-red-100" },
    improvement: { label: t("severityImprovement"), bg: "bg-amber-900/30", border: "border-amber-700", badge: "bg-amber-700 text-amber-100" },
    style: { label: t("severityStyle"), bg: "bg-blue-900/30", border: "border-blue-700", badge: "bg-blue-700 text-blue-100" },
  };

  const config = severityConfig[correction.severity];

  return (
    <div className={`rounded-lg ${config.bg} border ${config.border} p-3 space-y-2`}>
      <div className="flex items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${config.badge}`}>
          {config.label}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="rounded-md bg-red-900/30 px-3 py-2">
          <p className="text-xs text-red-400 mb-0.5">Original</p>
          <p className="text-sm text-gray-200">{correction.original}</p>
        </div>
        <div className="rounded-md bg-green-900/30 px-3 py-2">
          <p className="text-xs text-green-400 mb-0.5">Corrected</p>
          <p className="text-sm text-gray-200">{correction.corrected}</p>
        </div>
      </div>
      <p className="text-sm text-gray-400">{correction.explanation}</p>
    </div>
  );
}
