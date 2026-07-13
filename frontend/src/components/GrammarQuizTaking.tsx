import { useState, useEffect, useMemo } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { answerGrammarQuestion, getGrammarGroups, updateGrammarQuizWeights } from "../api/grammar";
import { fetchJson } from "../api/client";
import RubyText from "./RubyText";
import type { GrammarQuizSession, Grammar } from "../types";
import { isWeightValid, parseWeightInput } from "../utils/weightInput";

interface Props {
  session: GrammarQuizSession;
  onComplete: () => void;
  onStartNew: () => void;
}

export default function GrammarQuizTaking({ session, onComplete, onStartNew }: Props) {
  const { t } = useI18n();
  const { displayDefEntries, displayGrammarDefEntries } = useSettings();
  const [currentSession, setCurrentSession] = useState(session);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const idx = session.questions.findIndex((q) => q.userCorrect === undefined);
    return idx === -1 ? session.questions.length : idx;
  });
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [grammarCache, setGrammarCache] = useState<Map<string, Grammar>>(new Map());
  const [originalTotal] = useState(
    session.questions.filter((q) => q.userCorrect === undefined).length || session.questions.length
  );
  const [groupNameMap, setGroupNameMap] = useState<Map<string, string>>(new Map());
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [weightDraft, setWeightDraft] = useState<Record<string, string>>({});
  const [applyingWeights, setApplyingWeights] = useState(false);

  // Fetch grammar item details for showing statement/descriptions on answer reveal
  useEffect(() => {
    const ids = [...new Set(session.questions.map((q) => q.grammarId))];
    for (const id of ids) {
      if (!grammarCache.has(id)) {
        fetchJson<Grammar>(
          `/api/grammar/${encodeURIComponent(session.language)}/items/${encodeURIComponent(id)}`
        )
          .then((item) => {
            setGrammarCache((prev) => new Map(prev).set(id, item));
          })
          .catch(() => {});
      }
    }
  }, [session.questions, session.language]);

  useEffect(() => {
    if (!session.groupMembership || Object.keys(session.groupMembership).length === 0) return;
    getGrammarGroups(session.language)
      .then((groups) => setGroupNameMap(new Map(groups.map((g) => [g.id, g.name]))))
      .catch(() => {});
  }, [session.language, session.groupMembership]);

  const question =
    currentIndex < currentSession.questions.length ? currentSession.questions[currentIndex] : null;
  const isComplete = currentSession.status === "completed";
  const grammar = question ? grammarCache.get(question.grammarId) : null;

  const groupProgress = useMemo(() => {
    const membership = currentSession.groupMembership;
    if (!membership || Object.keys(membership).length === 0) return null;
    const unansweredIds = new Set(
      currentSession.questions.filter((q) => q.userCorrect === undefined).map((q) => q.grammarId)
    );
    return Object.entries(membership).map(([gid, ids]) => ({
      id: gid,
      name: groupNameMap.get(gid) ?? gid,
      remaining: ids.filter((id) => unansweredIds.has(id)).length,
      total: ids.length,
    }));
  }, [currentSession.groupMembership, currentSession.questions, groupNameMap]);

  function openWeightsPanel() {
    const membership = currentSession.groupMembership ?? {};
    setWeightDraft(
      Object.fromEntries(
        Object.keys(membership).map((gid) => [gid, String(currentSession.groupWeights?.[gid] ?? 1)])
      )
    );
    setWeightsOpen(true);
  }

  const hasInvalidWeightDraft = Object.keys(weightDraft).some((gid) => !isWeightValid(weightDraft[gid], 0));

  // Apply new group weights mid-session: the server reorders the unanswered tail and
  // returns the full session; jump to the first unanswered question of the new order.
  async function applyWeights() {
    if (applyingWeights || hasInvalidWeightDraft) return;
    setApplyingWeights(true);
    try {
      const weights = Object.fromEntries(
        Object.entries(weightDraft).map(([gid, v]) => [gid, Math.max(0, Math.floor(parseWeightInput(v) ?? 0))])
      );
      const updated = await updateGrammarQuizWeights(currentSession.language, weights);
      setCurrentSession(updated);
      const firstUnanswered = updated.questions.findIndex((q) => q.userCorrect === undefined);
      setCurrentIndex(firstUnanswered === -1 ? updated.questions.length : firstUnanswered);
      setShowingAnswer(false);
      setWeightsOpen(false);
    } catch {
      // Keep the panel open so the user can retry.
    } finally {
      setApplyingWeights(false);
    }
  }

  async function handleGrade(correct: boolean) {
    if (!question || submitting) return;
    setSubmitting(true);
    try {
      const result = await answerGrammarQuestion({
        language: currentSession.language,
        grammarId: question.grammarId,
        correct,
      });
      setCurrentSession(result.session);
      setCurrentIndex((i) => i + 1);
      setShowingAnswer(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (isComplete || (!question && currentIndex >= currentSession.questions.length)) {
    const { correct } = currentSession.score;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("congratulations")}</h2>
        <p className="text-2xl sm:text-4xl font-semibold text-emerald-400">
          {correct} / {originalTotal}
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => {
              onComplete();
              onStartNew();
            }}
            className="rounded-lg bg-emerald-600 px-6 py-2 text-white hover:bg-emerald-500"
          >
            {t("startNew")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <p className="text-sm text-gray-400">
        {currentSession.score.correct} / {originalTotal}
      </p>

      {groupProgress && (
        <div className="flex flex-wrap justify-center gap-2 items-center">
          {groupsOpen &&
            groupProgress.map((g) => (
              <span
                key={g.id}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  g.remaining === 0
                    ? "bg-green-900/40 text-green-400 border border-green-700/50"
                    : "bg-gray-700 text-gray-300 border border-gray-600"
                }`}
              >
                {g.name}: {g.remaining}/{g.total}
              </span>
            ))}
          <button
            onClick={() => setGroupsOpen((v) => !v)}
            aria-pressed={groupsOpen}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              groupsOpen
                ? "border-gray-400 bg-gray-700 text-gray-100"
                : "border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            🏷 {t("grammarGroups")}
          </button>
          <button
            onClick={() => (weightsOpen ? setWeightsOpen(false) : openWeightsPanel())}
            className="rounded-full border border-gray-600 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700"
          >
            ⚖ {t("adjustWeights")}
          </button>
        </div>
      )}

      {/* Mid-session group weight editor */}
      {weightsOpen && (
        <div className="w-full max-w-lg rounded-lg border border-gray-600 bg-gray-800 p-4 space-y-2">
          <p className="text-sm font-medium text-gray-300">{t("adjustWeights")}</p>
          {Object.keys(currentSession.groupMembership ?? {}).length > 0 && (
            <details open>
              <summary className="cursor-pointer text-xs font-semibold text-emerald-300 select-none">
                {t("grammarGroups")} ({Object.keys(currentSession.groupMembership ?? {}).length})
              </summary>
              <div className="mt-1 space-y-1">
                {Object.keys(currentSession.groupMembership ?? {}).map((gid) => {
                  const invalid = !isWeightValid(weightDraft[gid], 0);
                  return (
                    <label key={gid} className="flex items-center gap-2 text-sm text-gray-300">
                      <span className="flex-1 min-w-0 truncate pl-4">{groupNameMap.get(gid) ?? gid}</span>
                      <input
                        type="number"
                        min={0}
                        value={weightDraft[gid] ?? "1"}
                        title={t("groupWeightHint")}
                        aria-label={t("groupWeight")}
                        onChange={(e) => {
                          setWeightDraft((prev) => ({ ...prev, [gid]: e.target.value }));
                        }}
                        className={`w-16 shrink-0 rounded border bg-gray-700 px-2 py-1 text-xs text-gray-100 focus:outline-none ${
                          invalid ? "border-red-500 focus:border-red-400" : "border-gray-600 focus:border-emerald-400"
                        }`}
                      />
                    </label>
                  );
                })}
              </div>
            </details>
          )}
          {hasInvalidWeightDraft && (
            <p className="text-xs text-red-400">{t("groupWeightRequiredHint")}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setWeightsOpen(false)}
              className="rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700"
            >
              {t("cancel")}
            </button>
            <button
              onClick={applyWeights}
              disabled={applyingWeights || hasInvalidWeightDraft}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {applyingWeights ? "..." : t("applyWeights")}
            </button>
          </div>
        </div>
      )}

      {/* Question: the grammar element itself (user must recall its meaning/usage) */}
      <h2 className="max-w-lg text-center text-xl sm:text-3xl font-bold text-gray-100">
        {question!.statement || grammar?.statement}
      </h2>

      {!showingAnswer ? (
        <button
          onClick={() => setShowingAnswer(true)}
          className="rounded-lg bg-gray-700 px-6 py-2 text-gray-300 hover:bg-gray-600"
        >
          {t("showGrammarAnswer")}
        </button>
      ) : (
        <>
          {/* Reveal: descriptions */}
          {grammar && (
            <div className="w-full max-w-lg rounded-lg bg-gray-800 border border-gray-600 p-4">
              {grammar.descriptions?.map((d, di) => {
                const entries = displayDefEntries(d.text || {});
                const rows = entries.length > 0 ? entries : Object.entries(d.text || {});
                return (
                  <div key={di} className="mb-2 last:mb-0">
                    {d.partOfSpeech && (
                      <span className="mr-2 rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-300">
                        {d.partOfSpeech}
                      </span>
                    )}
                    {rows.map(([lang, text]) => (
                      <p key={lang} className="text-sm text-gray-300 whitespace-pre-line">
                        <span className="text-xs text-gray-500">[{lang}] </span>
                        {text}
                      </p>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {/* Registered examples (if any) */}
          {grammar && grammar.examples && grammar.examples.length > 0 && (
            <div className="w-full max-w-lg rounded-lg bg-gray-700 p-4">
              <p className="mb-2 text-sm font-medium text-gray-400">{t("examples")}</p>
              {grammar.examples.map((ex, i) => (
                <div key={i} className="mb-2 last:mb-0">
                  <p className="text-lg text-gray-100">
                    <RubyText text={ex.sentence} segments={ex.segments} />
                  </p>
                  {ex.transliteration && (
                    <p className="text-sm text-gray-500">{ex.transliteration}</p>
                  )}
                  {typeof ex.translation === "string" ? (
                    ex.translation && <p className="text-sm text-gray-400">{ex.translation}</p>
                  ) : (
                    displayGrammarDefEntries(ex.translation).map(([lang, text]) => (
                      <p key={lang} className="text-sm text-gray-400">
                        <span className="mr-1 text-xs font-medium uppercase text-gray-500">{lang}</span>
                        {text}
                      </p>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Self-grade buttons */}
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full sm:w-auto">
            <button
              disabled={submitting}
              onClick={() => handleGrade(true)}
              className="w-full sm:w-auto rounded-lg bg-green-600 px-6 py-2 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {t("iWasCorrect")}
            </button>
            <button
              disabled={submitting}
              onClick={() => handleGrade(false)}
              className="w-full sm:w-auto rounded-lg bg-red-600 px-6 py-2 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("iWasWrong")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
