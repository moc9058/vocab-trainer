import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { urlLanguageToIsoCode } from "../settings/defaults";
import { getCurrentSession } from "../api/quiz";
import { getCurrentGrammarSession } from "../api/grammar";
import { getCurrentCombinedSession } from "../api/combined-quiz";
import type { QuizSession, GrammarQuizSession, CombinedQuizSession } from "../types";

interface Props {
  language: string;
  onResume: (session: QuizSession) => void;
  onResumeGrammar: (session: GrammarQuizSession) => void;
  onResumeCombined: (session: CombinedQuizSession) => void;
  onCombinedQuiz: () => void;
  onResumeGroupB: (session: CombinedQuizSession) => void;
  onGroupBQuiz: () => void;
  onResumeMixed: (session: CombinedQuizSession) => void;
  onMixedQuiz: () => void;
  onStartNew: () => void;
  onBrowse: () => void;
  onFlaggedReview: () => void;
  onGrammarQuiz: () => void;
  onBrowseGrammar: () => void;
  /** Opens the article-import screen (the Word & Grammar browse view's import tab). */
  onImport: () => void;
  onAddWord: () => void;
  onAddGrammar: () => void;
  onStartTranslation: () => void;
  onResumeTranslation: () => void;
  hasTranslationHistory: boolean;
  onStartSpeakingWriting: () => void;
  onResumeSpeakingWriting: () => void;
  hasSWSession: boolean;
  onStartExpressionQuiz: () => void;
  onStartExpressionRecall: () => void;
  onBrowseExpressions: () => void;
  onAddExpression: () => void;
}

export default function EmptyState({ language, onResume, onResumeGrammar, onResumeCombined, onCombinedQuiz, onResumeGroupB, onGroupBQuiz, onResumeMixed, onMixedQuiz, onStartNew, onBrowse, onFlaggedReview, onGrammarQuiz, onBrowseGrammar, onImport, onAddWord, onAddGrammar, onStartTranslation, onResumeTranslation, hasTranslationHistory, onStartSpeakingWriting, onResumeSpeakingWriting, hasSWSession, onStartExpressionQuiz, onStartExpressionRecall, onBrowseExpressions, onAddExpression }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const isoCode = urlLanguageToIsoCode(language) ?? language;
  // Grammar used to be hidden for English on the assumption that an English source
  // yields none. The source importer extracts English patterns (tenses, participle
  // clauses, it-clefts) like any other language and registers them into the same
  // `grammar_items`, so the gate only meant the data could be created and browsed but
  // never drilled. Every language now gets the full grammar section; a language with
  // no items yet simply gets a 400 from `/start`, exactly as a fresh language always did.
  // The mixed Group A+B quiz is Chinese-only for now.
  const showMixed = isoCode === "zh";
  const sectionOrder: string[] = (settings.sectionOrder ?? ["word-grammar", "speaking-writing", "translation"]).filter(s => s !== "expressions");
  const [vocabSession, setVocabSession] = useState<QuizSession | null>(null);
  const [grammarSession, setGrammarSession] = useState<GrammarQuizSession | null>(null);
  const [combinedSession, setCombinedSession] = useState<CombinedQuizSession | null>(null);
  const [groupBSession, setGroupBSession] = useState<CombinedQuizSession | null>(null);
  const [mixedSession, setMixedSession] = useState<CombinedQuizSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [wordGrammarTab, setWordGrammarTab] = useState<"word" | "grammar">("word");

  useEffect(() => {
    if (!language) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // `allSettled`, not `all`: these getters now reject on a transport failure instead of
        // swallowing everything into `null`, and one domain being unreachable must not hide
        // the other resume buttons.
        const [vocabResult, grammarResult, combinedResult, groupBResult, mixedResult] = await Promise.allSettled([
          getCurrentSession(language),
          getCurrentGrammarSession(language),
          getCurrentCombinedSession(language),
          getCurrentCombinedSession(language, "groupB"),
          // The mixed quiz is Chinese-only, so don't spend a request looking for a session
          // that can never exist elsewhere.
          showMixed ? getCurrentCombinedSession(language, "mixed") : Promise.resolve(null),
        ]).then((results) =>
          results.map((r) => (r.status === "fulfilled" ? r.value : null))
        );
        if (!cancelled) {
          setVocabSession(vocabResult && vocabResult.status === "in-progress" ? (vocabResult as QuizSession) : null);
          setGrammarSession(grammarResult && grammarResult.status === "in-progress" ? (grammarResult as GrammarQuizSession) : null);
          setCombinedSession(combinedResult && combinedResult.status === "in-progress" ? (combinedResult as CombinedQuizSession) : null);
          setGroupBSession(groupBResult && groupBResult.status === "in-progress" ? (groupBResult as CombinedQuizSession) : null);
          setMixedSession(mixedResult && mixedResult.status === "in-progress" ? (mixedResult as CombinedQuizSession) : null);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [language, showMixed]);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("welcome")}</h2>

      <div className="w-full max-w-lg space-y-6">
        {sectionOrder.map((section) => {
          if (section === "word-grammar") return (
            <section key="word-grammar" className="rounded-xl bg-gray-800/60 p-4 sm:p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
                {t("sectionWordGrammar")}
              </h3>
              {/* Combined quiz spans both domains, so it sits above the word/grammar tabs. */}
              <div className="mb-3 space-y-2">
                {!loading && combinedSession && (
                  <button
                    onClick={() => onResumeCombined(combinedSession)}
                    className="w-full rounded-lg border border-indigo-700 bg-indigo-900/30 px-4 py-3 text-left hover:border-indigo-500 hover:bg-indigo-800/40 transition-colors"
                  >
                    <p className="font-semibold text-sm text-indigo-300">{t("resumeCombinedQuiz")}</p>
                    <p className="mt-0.5 text-xs text-indigo-400">
                      {combinedSession.score.correct} / {combinedSession.initialTotal ?? combinedSession.questions.length} {t("questionsAnswered")}
                    </p>
                  </button>
                )}
                <button
                  onClick={onCombinedQuiz}
                  className="w-full rounded-lg bg-indigo-600 px-5 py-3 text-center font-medium text-white hover:bg-indigo-500 transition-colors"
                >
                  {t("combinedQuiz")}
                </button>
                {!loading && groupBSession && (
                  <button
                    onClick={() => onResumeGroupB(groupBSession)}
                    className="w-full rounded-lg border border-amber-700 bg-amber-900/30 px-4 py-3 text-left hover:border-amber-500 hover:bg-amber-800/40 transition-colors"
                  >
                    <p className="font-semibold text-sm text-amber-300">{t("resumeGroupBQuiz")}</p>
                    <p className="mt-0.5 text-xs text-amber-400">
                      {groupBSession.score.correct} / {groupBSession.initialTotal ?? groupBSession.questions.length} {t("questionsAnswered")}
                    </p>
                  </button>
                )}
                <button
                  onClick={onGroupBQuiz}
                  className="w-full rounded-lg border border-amber-600 bg-amber-700/30 px-5 py-3 text-center font-medium text-amber-200 hover:bg-amber-700/50 transition-colors"
                >
                  {t("groupBQuiz")}
                </button>
                {/* Group A+B — one session spanning both meta-groups. Chinese only for now. */}
                {showMixed && (
                  <>
                    {!loading && mixedSession && (
                      <button
                        onClick={() => onResumeMixed(mixedSession)}
                        className="w-full rounded-lg border border-fuchsia-700 bg-fuchsia-900/30 px-4 py-3 text-left hover:border-fuchsia-500 hover:bg-fuchsia-800/40 transition-colors"
                      >
                        <p className="font-semibold text-sm text-fuchsia-300">{t("resumeMixedQuiz")}</p>
                        <p className="mt-0.5 text-xs text-fuchsia-400">
                          {mixedSession.score.correct} / {mixedSession.initialTotal ?? mixedSession.questions.length} {t("questionsAnswered")}
                        </p>
                      </button>
                    )}
                    <button
                      onClick={onMixedQuiz}
                      className="w-full rounded-lg bg-gradient-to-r from-indigo-600 to-amber-600 px-5 py-3 text-center font-medium text-white hover:from-indigo-500 hover:to-amber-500 transition-colors"
                    >
                      {t("mixedQuiz")}
                    </button>
                  </>
                )}
              </div>
              <div className="mb-3 flex gap-1 rounded-lg bg-gray-900/60 p-1">
                <button
                  onClick={() => setWordGrammarTab("word")}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${wordGrammarTab === "word" ? "bg-blue-600 text-white" : "text-gray-400 hover:text-gray-200"}`}
                >
                  {t("sectionVocabulary")}
                </button>
                <button
                  onClick={() => setWordGrammarTab("grammar")}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${wordGrammarTab === "grammar" ? "bg-emerald-600 text-white" : "text-gray-400 hover:text-gray-200"}`}
                >
                  {t("sectionGrammar")}
                </button>
              </div>
              {wordGrammarTab === "word" && (
                <>
                  {!loading && vocabSession && (
                    <div className="mb-3">
                      <button
                        onClick={() => onResume(vocabSession)}
                        className="w-full rounded-lg border border-blue-700 bg-blue-900/30 px-4 py-3 text-left hover:border-blue-500 hover:bg-blue-800/40 transition-colors"
                      >
                        <p className="font-semibold text-sm text-blue-300">{t("resumePreviousQuiz")}</p>
                        <p className="mt-0.5 text-xs text-blue-400">
                          {vocabSession.score.correct} / {vocabSession.wordIds?.length ?? vocabSession.questions.length} {t("questionsAnswered")}
                        </p>
                      </button>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      onClick={onStartNew}
                      className="sm:col-span-2 rounded-lg bg-blue-600 px-5 py-3 text-center font-medium text-white hover:bg-blue-500 transition-colors"
                    >
                      {t("startWordQuiz")}
                    </button>
                    <button
                      onClick={onBrowse}
                      className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      {t("browseWords")}
                    </button>
                    <button
                      onClick={onAddWord}
                      className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      {t("smartAddWord")}
                    </button>
                    <button
                      onClick={onFlaggedReview}
                      className="sm:col-span-2 rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      {t("reviewFlagged")}
                    </button>
                  </div>
                </>
              )}
              {wordGrammarTab === "grammar" && (
                <>
                  {!loading && grammarSession && (
                    <div className="mb-3">
                      <button
                        onClick={() => onResumeGrammar(grammarSession)}
                        className="w-full rounded-lg border border-emerald-700 bg-emerald-900/30 px-4 py-3 text-left hover:border-emerald-500 hover:bg-emerald-800/40 transition-colors"
                      >
                        <p className="font-semibold text-sm text-emerald-300">{t("resumePreviousQuiz")}</p>
                        <p className="mt-0.5 text-xs text-emerald-400">
                          {grammarSession.score.correct} / {grammarSession.questions.length} {t("questionsAnswered")}
                        </p>
                      </button>
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      onClick={onGrammarQuiz}
                      className="sm:col-span-2 rounded-lg bg-emerald-600 px-5 py-3 text-center font-medium text-white hover:bg-emerald-500 transition-colors"
                    >
                      {t("grammarQuiz")}
                    </button>
                    <button
                      onClick={onBrowseGrammar}
                      className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      {t("browseGrammar")}
                    </button>
                    <button
                      onClick={onAddGrammar}
                      className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      {t("addGrammar")}
                    </button>
                  </div>
                </>
              )}
              {/* Feeds BOTH domains at once, so it sits below the word/grammar tab
                  split rather than inside either tab. Solid, not dashed: it opens a
                  standing list of saved sources, so it is a real destination rather
                  than a placeholder — the same tinted-panel tier as the resume
                  buttons above, which keeps it clear of the primary quiz CTA. */}
              <button
                onClick={onImport}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-600 bg-indigo-900/40 px-4 py-2.5 text-center text-sm font-medium text-indigo-200 transition-colors hover:border-indigo-400 hover:bg-indigo-800/50"
              >
                {t("importFromSource")}
                <span aria-hidden="true" className="text-indigo-400">→</span>
              </button>
            </section>
          );
          if (section === "speaking-writing") return (
            <section key="speaking-writing" className="rounded-xl bg-gray-800/60 p-4 sm:p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
                {t("sectionSpeakingWriting")}
              </h3>
              {!loading && hasSWSession && (
                <div className="mb-3">
                  <button
                    onClick={onResumeSpeakingWriting}
                    className="w-full rounded-lg border border-teal-700 bg-teal-900/30 px-4 py-3 text-left hover:border-teal-500 hover:bg-teal-800/40 transition-colors"
                  >
                    <p className="font-semibold text-sm text-teal-300">{t("resumeSpeakingWriting")}</p>
                  </button>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  onClick={onStartSpeakingWriting}
                  className="sm:col-span-2 rounded-lg bg-teal-600 px-5 py-3 text-center font-medium text-white hover:bg-teal-500 transition-colors"
                >
                  {t("startSpeakingWriting")}
                </button>
                {isoCode !== "zh" && (
                  <>
                    {/* Two expression quizzes: recall (flashcard, no LLM) and the
                        original writing quiz (compose a sentence, LLM-graded). */}
                    <button
                      onClick={onStartExpressionRecall}
                      className="sm:col-span-2 rounded-lg bg-amber-600 px-5 py-3 text-center font-medium text-white hover:bg-amber-500 transition-colors"
                    >
                      {t("startExpressionRecallQuiz")}
                    </button>
                    <button
                      onClick={onStartExpressionQuiz}
                      className="sm:col-span-2 rounded-lg bg-orange-600 px-5 py-3 text-center font-medium text-white hover:bg-orange-500 transition-colors"
                    >
                      {t("startExpressionQuiz")}
                    </button>
                    <button
                      onClick={onBrowseExpressions}
                      className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      {t("browseExpressions")}
                    </button>
                    <button
                      onClick={onAddExpression}
                      className="rounded-lg border border-gray-600 px-4 py-2.5 text-center text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      {t("addExpression")}
                    </button>
                  </>
                )}
              </div>
            </section>
          );
          if (section === "translation") return (
            <section key="translation" className="rounded-xl bg-gray-800/60 p-4 sm:p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
                {t("sectionTranslation")}
              </h3>
              {!loading && hasTranslationHistory && (
                <div className="mb-3">
                  <button
                    onClick={onResumeTranslation}
                    className="w-full rounded-lg border border-violet-700 bg-violet-900/30 px-4 py-3 text-left hover:border-violet-500 hover:bg-violet-800/40 transition-colors"
                  >
                    <p className="font-semibold text-sm text-violet-300">{t("resumeTranslation")}</p>
                  </button>
                </div>
              )}
              <button
                onClick={onStartTranslation}
                className="w-full rounded-lg bg-violet-600 px-5 py-3 text-center font-medium text-white hover:bg-violet-500 transition-colors"
              >
                {t("startTranslation")}
              </button>
            </section>
          );
          return null;
        })}
      </div>
    </div>
  );
}
