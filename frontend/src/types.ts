export type UILanguage = "en";

/** Safely convert a translation that may be a string or object to a displayable string */
export function displayTranslation(t: string | Record<string, string> | null | undefined): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  return Object.values(t || {}).join("; ");
}

export interface Example {
  /** ExampleSentence doc ID when hydrated from the backend; absent on fresh drafts. */
  id?: string;
  sentence: string;
  translation: string | Record<string, string>;
  segments?: { text: string; transliteration?: string; id?: string }[];
  /** Input-only: user-specified segment splits (spaces in sentence field), never persisted. */
  userSplits?: string[];
}

export interface QuizScore {
  correct: number;
  total: number;
}

export interface Meaning {
  partOfSpeech: string;
  text: Record<string, string>;
  pinyins?: string[];
}

export interface HanjaReading {
  simplifiedChar: string;
  traditionalChar: string;
  hunEum: string[];
}

export interface QuizQuestion {
  wordId: string;
  term: string;
  definitions: Meaning[];
  transliteration?: string;
  examples?: Example[];
  userCorrect?: boolean;
  hanjaReadings?: HanjaReading[];
}

export interface QuizSession {
  sessionId: string;
  language: string;
  startedAt: string;
  completedAt?: string;
  status: "in-progress" | "completed";
  score: QuizScore;
  questions: QuizQuestion[];
  questionType?: string;
  wordIds?: string[];
  groupWeights?: Record<string, number>;
  groupMembership?: Record<string, string[]>;
  pendingWordIds?: string[];
  questionTarget?: number;
  flaggedOnly?: boolean;
}

export interface Word {
  id: string;
  term: string;
  transliteration?: string;
  definitions: Meaning[];
  examples: Example[];
  topics: string[];
  level?: string;
  notes?: string;
  hanjaReadings?: HanjaReading[];
}

export interface WordGroup {
  id: string;
  language: string;
  name: string;
  wordIds: string[];
  createdAt: string;
  order?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ========== Grammar ==========

export interface GrammarExample {
  sentence: string;
  translation: string | Record<string, string>;
  transliteration?: string;
  segments?: { text: string; transliteration?: string; id?: string }[];
  /** Input-only: user-specified segment splits (spaces in sentence field), never persisted. */
  userSplits?: string[];
}

export interface Grammar {
  id: string;
  language: string;
  statement: string;
  descriptions: Meaning[];
  /** @deprecated Use `exampleIds` + the `example_sentences` collection. Kept as a transitional fallback. */
  examples?: GrammarExample[];
  exampleIds?: string[];
  words?: string[];
  level?: string;
  tags?: string[];
}

export interface GrammarSettings {
  defaultDefinitionLanguage: string;
}

export interface GrammarGroup {
  id: string;
  language: string;
  name: string;
  grammarIds: string[];
  createdAt: string;
}

export interface GrammarQuizQuestion {
  grammarId: string;
  exampleSentence: string;
  exampleTranslation: string | Record<string, string>;
  exampleTransliteration?: string;
  userCorrect?: boolean;
}

export interface GrammarQuizSession {
  sessionId: string;
  language: string;
  startedAt: string;
  completedAt?: string;
  status: "in-progress" | "completed";
  score: QuizScore;
  questions: GrammarQuizQuestion[];
  groupFilter?: string[];
}

// ========== Combined Quiz (words + grammar) ==========

export interface CombinedQuizWordQuestion extends QuizQuestion {
  kind: "word";
}

export interface CombinedQuizGrammarQuestion extends GrammarQuizQuestion {
  kind: "grammar";
}

export type CombinedQuizQuestion = CombinedQuizWordQuestion | CombinedQuizGrammarQuestion;

// How often word questions are drawn vs grammar questions (proportional, like group weights).
export interface CombinedDomainWeights {
  word: number;
  grammar: number;
}

export interface CombinedQuizSession {
  sessionId: string;
  language: string;
  startedAt: string;
  completedAt?: string;
  status: "in-progress" | "completed";
  score: QuizScore;
  questions: CombinedQuizQuestion[];
  domainWeights: CombinedDomainWeights;
  // Question count at start — retry re-queues grow `questions`, so the UI shows X / initialTotal.
  initialTotal: number;
  wordGroupWeights?: Record<string, number>;
  wordGroupMembership?: Record<string, string[]>;
  grammarGroupWeights?: Record<string, number>;
  grammarGroupMembership?: Record<string, string[]>;
  flaggedOnly?: boolean;
}

// ========== Translation ==========

export interface AnalysisComponent {
  componentId: string;
  surface: string;
  baseForm: string | null;
  reading: string | null;
  partOfSpeech: string;
  meaning: string;
  explanation: string;
}

export interface AnalysisChunk {
  chunkId: string;
  surface: string;
  meaning: string;
  components: AnalysisComponent[];
}

export interface SentenceAnalysis {
  sentenceId: string;
  text: string;
  meaning?: string;
  chunks: AnalysisChunk[];
  components?: AnalysisComponent[];
}

export interface SentenceAnalysisResult {
  sentences: SentenceAnalysis[];
}

export interface TranslationPassage {
  sentenceIds: string[];
  translation: string;
}

export interface TranslationResult {
  language: string;
  error?: string;
  passages?: TranslationPassage[];
  analysis?: SentenceAnalysisResult;
}

export interface TranslationEntry {
  id: string;
  sourceLanguage: string;
  sourceText: string;
  /** Optional user-provided situation/register hint reflected in translations. */
  context?: string;
  targetLanguages: string[];
  results: TranslationResult[];
  createdAt: string;
}

// ========== Speaking & Writing ==========

export interface CorrectionItem {
  original: string;
  corrected: string;
  explanation: string;
  severity: "error" | "improvement" | "style";
}

export interface CorrectionResult {
  originalText: string;
  correctedText: string;
  corrections: CorrectionItem[];
  overallFeedback: string;
}

export interface SpeakingWritingEntry {
  inputText: string;
  result: CorrectionResult;
  createdAt: string;
}

export interface SpeakingWritingSession {
  sessionId: string;
  language: string;
  mode: "speaking" | "writing";
  useCase: string;
  startedAt: string;
  status: "in-progress" | "completed";
  corrections: SpeakingWritingEntry[];
  currentIndex: number;
  expressionQuiz?: ExpressionQuizSubsession;
}

// ========== Expressions ==========

export interface Expression {
  id: string;
  language: string;
  phrase: string;
  context: string;
  description?: string;
  purpose?: ("speaking" | "writing")[];
  groupIds?: string[];
}

export interface ExpressionGroup {
  id: string;
  language: string;
  name: string;
  expressionIds: string[];
  createdAt: string;
}

export interface ExpressionQuizQuestion {
  expressionId: string;
  phrase: string;
  context: string;
  description?: string;
  userInput?: string;
  correctionResult?: CorrectionResult;
  userCorrect?: boolean;
}

export interface ExpressionQuizSubsession {
  purposeFilter?: ("speaking" | "writing")[];
  startedAt: string;
  completedAt?: string;
  status: "in-progress" | "completed";
  score: QuizScore;
  questions: ExpressionQuizQuestion[];
  groupFilter?: string[];
}
