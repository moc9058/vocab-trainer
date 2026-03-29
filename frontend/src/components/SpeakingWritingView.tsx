import { useState, useEffect, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { ALL_KNOWN_LANGUAGES } from "../settings/defaults";
import { submitCorrection, getSpeakingWritingSession, deleteSpeakingWritingSession } from "../api/speaking-writing";
import { fetchJson } from "../api/client";
import type { SpeakingWritingSession, CorrectionItem } from "../types";

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

  const [phase, setPhase] = useState<"input" | "loading" | "results">("input");
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>("en");
  const [selectedMode, setSelectedMode] = useState<"speaking" | "writing">("writing");
  const [inputText, setInputText] = useState("");
  const [session, setSession] = useState<SpeakingWritingSession | null>(null);
  const [correctionIndex, setCorrectionIndex] = useState(0);
  const [loadingSession, setLoadingSession] = useState(mode === "resume");
  const [error, setError] = useState<string | null>(null);

  // Resume: find existing session
  useEffect(() => {
    if (mode !== "resume") return;
    let cancelled = false;
    (async () => {
      try {
        const languages = await fetchJson<{ filename: string }[]>("/api/languages/");
        for (const lang of languages) {
          const key = lang.filename.replace(/\.json$/, "");
          const sess = await getSpeakingWritingSession(key);
          if (sess && sess.corrections.length > 0) {
            if (!cancelled) {
              setSession(sess);
              setSelectedLanguage(sess.language);
              setSelectedMode(sess.mode);
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

  // New mode: delete all existing sessions on mount
  useEffect(() => {
    if (mode !== "new") return;
    let cancelled = false;
    (async () => {
      try {
        const languages = await fetchJson<{ filename: string }[]>("/api/languages/");
        for (const lang of languages) {
          const key = lang.filename.replace(/\.json$/, "");
          await deleteSpeakingWritingSession(key).catch(() => {});
        }
      } catch {
        // ignore
      }
      if (!cancelled) {
        setSession(null);
        setCorrectionIndex(0);
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  const canSubmit = inputText.trim().length > 0 && selectedLanguage;

  async function handleSubmit() {
    if (!canSubmit || !selectedLanguage) return;
    setError(null);
    setPhase("loading");
    try {
      const updatedSession = await submitCorrection(selectedLanguage, selectedMode, inputText.trim());
      setSession(updatedSession);
      setCorrectionIndex(updatedSession.corrections.length - 1);
      setInputText("");
      setPhase("results");
    } catch (err) {
      console.error("Correction failed:", err);
      setError(String(err));
      setPhase("input");
    }
  }

  function handleNewCorrection() {
    setPhase("input");
    setInputText("");
    setError(null);
  }

  function handlePrevious() {
    if (correctionIndex > 0) {
      setCorrectionIndex(correctionIndex - 1);
    }
  }

  function handleNext() {
    if (session && correctionIndex < session.corrections.length - 1) {
      setCorrectionIndex(correctionIndex + 1);
    }
  }

  if (loadingSession) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-teal-400 border-t-transparent" />
      </div>
    );
  }

  // ===== INPUT PHASE =====
  if (phase === "input") {
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6 space-y-5">
        <h2 className="text-lg font-bold text-gray-100">{t("sectionSpeakingWriting")}</h2>

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
              onClick={() => setSelectedMode("speaking")}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                selectedMode === "speaking"
                  ? "bg-teal-600 text-white"
                  : "border border-gray-600 text-gray-400 hover:bg-gray-700"
              }`}
            >
              {t("modeSpeaking")}
            </button>
            <button
              onClick={() => setSelectedMode("writing")}
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
        <div className="flex items-center justify-center gap-3 py-12">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-teal-400 border-t-transparent" />
          <p className="text-teal-400 font-medium">{t("correcting")}</p>
        </div>
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
        <div className="flex-1" />
        {correctionIndex > 0 && (
          <button
            onClick={handlePrevious}
            className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t("previous")}
          </button>
        )}
        {correctionIndex < session.corrections.length - 1 && (
          <button
            onClick={handleNext}
            className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
          >
            {t("next")}
          </button>
        )}
      </div>

      {/* Original text */}
      <div className="rounded-lg bg-gray-800/60 p-4">
        <p className="text-sm text-gray-400 mb-1">{t("originalText")}</p>
        <p className="text-gray-100 whitespace-pre-wrap">{entry.inputText}</p>
      </div>

      {/* Corrected text */}
      <div className="rounded-lg bg-teal-900/30 border border-teal-700 p-4">
        <p className="text-sm text-teal-400 mb-1 font-semibold">{t("overallCorrectedText")}</p>
        <p className="text-gray-100 whitespace-pre-wrap">{result.overallCorrectedText}</p>
      </div>

      {/* Individual corrections */}
      {result.corrections.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-400">{t("corrections")}</h3>
          {result.corrections.map((correction, i) => (
            <CorrectionCard key={i} correction={correction} />
          ))}
        </div>
      )}

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

function CorrectionCard({ correction }: { correction: CorrectionItem }) {
  const { t } = useI18n();

  const severityConfig = {
    error: { label: t("severityError"), bg: "bg-red-900/40", border: "border-red-700", badge: "bg-red-700 text-red-100" },
    improvement: { label: t("severityImprovement"), bg: "bg-amber-900/30", border: "border-amber-700", badge: "bg-amber-700 text-amber-100" },
    style: { label: t("severityStyle"), bg: "bg-blue-900/30", border: "border-blue-700", badge: "bg-blue-700 text-blue-100" },
  };

  const config = severityConfig[correction.severity];

  return (
    <div className={`rounded-lg ${config.bg} border ${config.border} p-4 space-y-2`}>
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
