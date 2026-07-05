import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { urlLanguageToIsoCode } from "../settings/defaults";
import { getCurrentSession } from "../api/quiz";
import { getCurrentGrammarSession } from "../api/grammar";
import type { QuizSession, GrammarQuizSession } from "../types";

interface Props {
  language: string;
  onResume: (session: QuizSession) => void;
  onResumeGrammar: (session: GrammarQuizSession) => void;
  onStartNew: () => void;
  onBrowse: () => void;
  onFlaggedReview: () => void;
  onGrammarQuiz: () => void;
  onBrowseGrammar: () => void;
  onAddWord: () => void;
  onAddGrammar: () => void;
  onStartTranslation: () => void;
  onResumeTranslation: () => void;
  hasTranslationHistory: boolean;
  onStartSpeakingWriting: () => void;
  onResumeSpeakingWriting: () => void;
  hasSWSession: boolean;
  onStartExpressionQuiz: () => void;
  onBrowseExpressions: () => void;
  onAddExpression: () => void;
}

export default function EmptyState({ language, onResume, onResumeGrammar, onStartNew, onBrowse, onFlaggedReview, onGrammarQuiz, onBrowseGrammar, onAddWord, onAddGrammar, onStartTranslation, onResumeTranslation, hasTranslationHistory, onStartSpeakingWriting, onResumeSpeakingWriting, hasSWSession, onStartExpressionQuiz, onBrowseExpressions, onAddExpression }: Props) {
  const { t } = useI18n();
  const { settings } = useSettings();
  const isoCode = urlLanguageToIsoCode(language) ?? language;
  const showGrammar = isoCode !== "en";
  const sectionOrder: string[] = (settings.sectionOrder ?? ["word-grammar", "speaking-writing", "translation"]).filter(s => s !== "expressions");
  const [vocabSession, setVocabSession] = useState<QuizSession | null>(null);
  const [grammarSession, setGrammarSession] = useState<GrammarQuizSession | null>(null);
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
        const [vocabResult, grammarResult] = await Promise.all([
          getCurrentSession(language),
          getCurrentGrammarSession(language),
        ]);
        if (!cancelled) {
          setVocabSession(vocabResult && vocabResult.status === "in-progress" ? vocabResult : null);
          setGrammarSession(grammarResult && grammarResult.status === "in-progress" ? grammarResult : null);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [language]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4 sm:p-8">
      <h2 className="text-xl sm:text-2xl font-bold text-gray-100">{t("welcome")}</h2>

      <div className="w-full max-w-lg space-y-6">
        {sectionOrder.map((section) => {
          if (section === "word-grammar") return (
            <section key="word-grammar" className="rounded-xl bg-gray-800/60 p-4 sm:p-5">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
                {t("sectionWordGrammar")}
              </h3>
              {showGrammar && (
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
              )}
              {(!showGrammar || wordGrammarTab === "word") && (
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
              {showGrammar && wordGrammarTab === "grammar" && (
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
