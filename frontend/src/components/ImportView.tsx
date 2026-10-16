import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import {
  startImportAnalysisJob,
  resumeImportAnalysisJob,
  deleteImportSession,
  listImportSessions,
} from "../api/import";
import { getGrammarSettings } from "../api/grammar";
import ImportDestinationRail from "./import/ImportDestinationRail";
import ImportReview from "./import/ImportReview";
import ImportSessionList from "./import/ImportSessionList";
import { useImportGroups } from "../hooks/useImportGroups";
import { useImportSession } from "../hooks/useImportSession";
import { useImportAnalysisJob } from "../hooks/useImportAnalysisJob";
import { ApiError } from "../api/client";
import { deriveArticleQuizPools, poolSize } from "../utils/importQuizPool";
import type { ImportQuizPool, ImportSession, ImportSessionSummary } from "../types";
import type { useWordQueue } from "../hooks/useWordQueue";
import type { useGrammarQueue } from "../hooks/useGrammarQueue";

interface Props {
  /** Backend full-name language (e.g. "chinese") — the language the article is in. */
  language: string;
  onQueue: ReturnType<typeof useWordQueue>["enqueue"];
  onGrammarQueue: ReturnType<typeof useGrammarQueue>["enqueue"];
  /** Start an article quiz over every saved article. Optional so this view still renders
   *  in a host that has no quiz routes. */
  onArticleQuiz?: (category: "A" | "B", pool: ImportQuizPool) => void;
}

type Phase = "sessions" | "input" | "analyzing" | "review";

const MAX_TEXT = 8000;
/** Stable identity so the pool memo doesn't re-run on every render before the fetch lands. */
const EMPTY_POOL: ImportQuizPool = { wordIds: [], grammarIds: [] };
/** Long sources get a reminder that completed parts are saved and can be resumed. */
const LONG_TEXT_WARNING = 1500;

/** Phase router for the article importer; all session state lives in `useImportSession`. */
export default function ImportView({ language, onQueue, onGrammarQueue, onArticleQuiz }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("sessions");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [descriptionLanguage, setDescriptionLanguage] = useState("ja");

  const [sessions, setSessions] = useState<ImportSessionSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  // Rides along with the session list — see `api/import.ts:listImportSessions`.
  const [quizPool, setQuizPool] = useState<ImportQuizPool>(EMPTY_POOL);

  // Destination for a session that does not exist yet; carried into `create`.
  const [draftDestination, setDraftDestination] = useState<{
    wordGroupId?: string;
    grammarGroupId?: string;
    groupBNames: string[];
  }>({ groupBNames: [] });

  const abortRef = useRef<AbortController | null>(null);

  // One read of the group collections for the whole screen — the destination
  // selects and the membership chips are two views of the same documents.
  const groups = useImportGroups(language);

  const {
    session,
    prepareAnalysis,
    acceptAnalysisSession,
    saveStatus,
    saveError,
    membershipOverlay,
    create,
    load,
    close,
    patch,
    setItems,
    patchItem,
    registerItem,
    retrySave,
  } = useImportSession({
    language,
    onQueue,
    onGrammarQueue,
    descriptionLanguage,
    onMembershipChanged: groups.reload,
  });

  const monitor = useImportAnalysisJob(language, acceptAnalysisSession, job => {
    setError(job.state === "failed" ? t(job.error?.code === "IMPORT_STORAGE_LIMIT" ? "importAnalysisTooLarge"
      : job.error?.code === "IMPORT_CONFIG_ERROR" ? "importJobConfigError"
      : (job.error?.code === "IMPORT_OUTPUT_LIMIT" && !job.error.retryable) || job.error?.code === "IMPORT_INVALID_OUTPUT" ? "importJobOutputError" : "importAnalysisRetryHint") : null);
    setPhase("review");
  });

  const refreshSessions = useCallback(() => {
    setListLoading(true);
    listImportSessions(language)
      .then(({ sessions: rows, pool }) => {
        setSessions(rows);
        setQuizPool(pool);
      })
      .catch(() => {
        setSessions([]);
        setQuizPool(EMPTY_POOL);
      })
      .finally(() => setListLoading(false));
  }, [language]);

  // The group documents are already loaded for the destination rail, so splitting the
  // article union into its Group A and Group B halves costs no extra request.
  const articlePools = useMemo(
    () => deriveArticleQuizPools(quizPool, groups.wordGroups, groups.grammarGroups),
    [quizPool, groups.wordGroups, groups.grammarGroups]
  );

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    getGrammarSettings()
      .then((s) => { if (s?.defaultDefinitionLanguage) setDescriptionLanguage(s.defaultDefinitionLanguage); })
      .catch(() => {});
  }, []);

  // Cancel an in-flight analysis if the view unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function handleAnalyze(existing?: ImportSession) {
    if (abortRef.current || (!existing && !text.trim())) return;
    const controller = new AbortController(); abortRef.current = controller;
    monitor.stop(); setError(null); setPhase("analyzing");
    let current = existing;
    const key = crypto.randomUUID();
    try {
      current = existing ? await prepareAnalysis() ?? existing : await create({
        title: text.trim().slice(0, 40), text: text.trim(), paragraphs: [], items: [], analyzeAsJob: true,
        ...draftDestination, focusedSentenceIndex: 0, status: "in-progress",
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (current.analysisJobRef) await resumeImportAnalysisJob(language, current.id, key, controller.signal);
      else await startImportAnalysisJob(language, current.id, key, current.analysisRevision ?? 0, controller.signal);
      if (!controller.signal.aborted) monitor.watch(current.id, { key, revision: current.analysisRevision ?? 0 });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (current && !(err instanceof ApiError)) {
        // Lost acceptance response: query the SAME durable job; never create a replacement.
        monitor.watch(current.id, { key, revision: current.analysisRevision ?? 0 });
      } else { setError(err instanceof Error ? err.message : String(err)); setPhase(current ? "review" : "input"); }
    } finally { if (abortRef.current === controller) abortRef.current = null; }
  }

  async function handleResume(sessionId: string) {
    monitor.stop(); setError(null);
    try {
      const loaded = await load(sessionId);
      if (loaded.analysisJobRef) {
        setPhase("analyzing"); monitor.watch(sessionId);
      } else setPhase("review");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  async function handleDelete(sessionId: string) {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    try {
      await deleteImportSession(language, sessionId);
    } catch {
      refreshSessions();
    }
  }

  function exitToList() {
    monitor.stop(); close();
    setText("");
    setPhase("sessions");
    refreshSessions();
  }

  // ===== REVIEW =====
  if (phase === "review" && session) {
    return (
      <ImportReview
        session={session}
        allWordGroups={groups.wordGroups}
        allGrammarGroups={groups.grammarGroups}
        membershipOverlay={membershipOverlay}
        saveStatus={saveStatus}
        saveError={saveError}
        onRetrySave={retrySave}
        onPatch={patch}
        onSetItems={setItems}
        onPatchItem={patchItem}
        onRegister={registerItem}
        onExit={exitToList}
        analysisError={error}
        onContinueAnalysis={(error === t("importAnalysisTooLarge") || monitor.job?.error?.retryable === false) ? undefined : () => void handleAnalyze(session)}
      />
    );
  }

  // ===== ANALYZING =====
  if (phase === "analyzing") {
    const progress = session?.analysisProgress;
    const job = monitor.job;
    const completed = session?.paragraphs.flatMap(p => p.sentences) ?? [];
    return (
      <div className="h-full overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-3xl px-3 py-4 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
            <span className="text-sm text-gray-300">{monitor.reconnecting ? t("importJobReconnecting") : t("importAnalyzing")} {job ? `${job.nextBatch} / ${job.totalBatches}` : "…"}</span>
            <button
              onClick={() => { abortRef.current?.abort(); abortRef.current = null; monitor.stop(); close(); setPhase("sessions"); refreshSessions(); }}
              className="ml-auto shrink-0 text-sm text-gray-400 hover:text-gray-200"
            >
              {t("importBackToSessions")}
            </button>
          </div>
          <p className="mb-4 text-sm text-gray-400">{t("importJobBackgroundHint")}</p>
          {monitor.error && <p role="alert" className="mb-3 text-sm text-red-300">{monitor.error}</p>}
          {job && <button type="button" disabled={job.pauseRequested} onClick={() => void monitor.pause()}
            className="mb-4 rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 disabled:opacity-40">{job.pauseRequested ? t("importJobPausing") : t("importJobPause")}</button>}
          {progress && <p className="mb-4 line-clamp-3 whitespace-pre-wrap text-sm text-gray-500">{progress.chunks[job?.nextBatch ?? progress.nextChunk]}</p>}
          <ol className="space-y-2">
            {completed.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-gray-300 sm:gap-3">
                <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-[11px] text-gray-600 sm:w-6">
                  {i + 1}
                </span>
                <span className="min-w-0 break-words">{s.text}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  // ===== INPUT =====
  if (phase === "input") {
    return (
      <div className="h-full overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-5xl px-3 py-4 sm:p-6">
          <header className="mb-5 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold text-gray-100 sm:text-lg">{t("importNewSession")}</h2>
              <p className="mt-1 text-xs text-gray-400 sm:text-sm">{t("importDescription")}</p>
            </div>
            <button
              onClick={() => setPhase("sessions")}
              className="shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:border-gray-500 hover:text-gray-200 sm:text-sm"
            >
              {t("cancel")}
            </button>
          </header>

          {error && (
            <p className="mb-4 rounded-lg border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-[1fr_19rem] lg:gap-5">
            <div>
              {/* `text-base` keeps iOS from zooming the viewport on focus — the
                  usual cause of a page that suddenly scrolls sideways. */}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={MAX_TEXT}
                rows={16}
                placeholder={t("importPastePlaceholder")}
                className="h-48 w-full resize-y rounded-2xl border border-gray-700 bg-gray-800/60 px-3 py-3 text-base leading-relaxed text-gray-100 placeholder-gray-600 focus:border-indigo-500 focus:outline-none sm:h-auto sm:px-4 sm:text-[15px]"
              />
              <p
                className={`mt-1 text-right text-xs ${
                  text.length > LONG_TEXT_WARNING ? "text-amber-500/90" : "text-gray-600"
                }`}
              >
                {text.length} / {MAX_TEXT}
              </p>
              {text.length > LONG_TEXT_WARNING && (
                <p className="mt-1 rounded-lg border border-amber-700/50 bg-amber-950/25 px-3 py-2 text-[11px] leading-snug text-amber-200/90">
                  {t("importLongTextWarning")}
                </p>
              )}
            </div>

            <div className="space-y-3">
              <ImportDestinationRail
                language={language}
                allWordGroups={groups.wordGroups}
                allGrammarGroups={groups.grammarGroups}
                wordGroupId={draftDestination.wordGroupId}
                grammarGroupId={draftDestination.grammarGroupId}
                groupBNames={draftDestination.groupBNames}
                onChange={(p) => setDraftDestination((prev) => ({ ...prev, ...p }))}
                autoSelectLatest
              />
              <button
                onClick={() => void handleAnalyze()}
                disabled={!text.trim()}
                className="w-full rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("importAnalyze")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ===== SESSION LIST =====
  return (
    <>
      {error && (
        <p className="mx-auto mt-4 max-w-3xl rounded-lg border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      <ImportSessionList
        sessions={sessions}
        loading={listLoading}
        onResume={handleResume}
        onDelete={handleDelete}
        onNew={() => { setError(null); setPhase("input"); }}
        quizCounts={{ a: poolSize(articlePools.a), b: poolSize(articlePools.b) }}
        onQuiz={
          onArticleQuiz &&
          ((category) => onArticleQuiz(category, category === "A" ? articlePools.a : articlePools.b))
        }
      />
    </>
  );
}
