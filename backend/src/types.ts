export interface Example {
  /**
   * The underlying ExampleSentence document ID. Populated by `hydrateWords`
   * for persisted examples; absent on client-side drafts (e.g. a new example
   * being entered in a form) and on legacy embedded-example words.
   */
  id?: string;
  sentence: string;
  translation: string | Record<string, string>;
  segments?: { text: string; transliteration?: string; id?: string }[];
}

export interface ExampleSentence {
  id: string;
  sentence: string;
  translation: string | Record<string, string>;
  segments?: { text: string; transliteration?: string; id?: string }[];
  language: string;
  ownerWordId?: string;
  appearsInGrammarIds?: string[];
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

export interface Word {
  id: string;
  term: string;
  transliteration?: string;
  definitions: Meaning[];
  examples: Example[];
  topics: Topic[];
  level?: string;
  notes?: string;
  hanjaReadings?: HanjaReading[];
}

export const TOPICS = [
  // Everyday Life
  "Greetings & Introductions",
  "Food & Dining",
  "Shopping & Money",
  "Travel & Transportation",
  "Weather & Seasons",
  "Family & Relationships",
  "Health & Body",
  "Home & Housing",
  "Numbers, Time & Dates",
  "Social Interaction",
  // Academic / Professional
  "Economics & Finance",
  "Politics & Government",
  "Science & Technology",
  "Law & Justice",
  "Medicine",
  "Education",
  "Business & Commerce",
  "Work & Career",
  "Military & War",
  // Culture & Society
  "Nature & Environment",
  "Arts & Entertainment",
  "Sports & Fitness",
  "Religion & Philosophy",
  "History",
  "Media & News",
  "Emotions & Psychology",
  // Language Fundamentals
  "Language Fundamentals",
  // Other
  "Miscellaneous",
] as const;

export type Topic = (typeof TOPICS)[number];

export interface WordGroup {
  id: string;
  language: string;
  name: string;
  wordIds: string[];
  createdAt: string;
}

export interface VocabFile {
  language?: string;
  words: Word[];
}

export interface WordIndexEntry {
  term: string;
  id: string;
  level: string;
  transliteration: string;
}

export interface LanguageInfo {
  filename: string;
  language: string;
  topics: Topic[];
  levels: string[];
  wordCount: number;
}

export interface WordProgress {
  timesSeen: number;
  timesCorrect: number;
  correctRate: number;
  lastReviewed: string;
  streak: number;
}

export interface ProgressFile {
  language: string;
  words: Record<string, WordProgress>;
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

export interface QuizScore {
  correct: number;
  total: number;
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
  translation: string;
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
  /** @deprecated Use `exampleIds` + the `example_sentences` collection. Kept as a transitional fallback until all docs are migrated. */
  examples?: GrammarExample[];
  exampleIds?: string[];
  words?: string[];
  level?: string;
  tags?: string[];
}

export interface GrammarGroup {
  id: string;
  language: string;
  name: string;
  grammarIds: string[];
  createdAt: string;
}

export interface GrammarProgress {
  timesSeen: number;
  timesCorrect: number;
  correctRate: number;
  lastReviewed: string;
  streak: number;
}

export interface GrammarQuizQuestion {
  grammarId: string;
  exampleSentence: string;
  exampleTranslation: string;
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

// ========== Token Usage Metrics ==========

export interface TokenUsageRecord {
  id: string;
  timestamp: string;
  model: string;
  caller: string;
  route: string;

  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  thoughtsTokens?: number;
}

export interface TokenUsageDailySummary {
  model: string;
  date: string;
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;

  byRoute: Record<string, {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
}

export interface TokenCostRate {
  input: number;
  cachedInput: number;
  output: number;
  thoughtsInput: number;
}

export interface TokenCostConfig {
  models: Record<string, TokenCostRate>;
  updatedAt: string;
}

export interface UsageMetricsSummary {
  period: { from: string; to: string };
  byModel: Record<string, {
    totalCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    thoughtsTokens: number;
    estimatedCost: number;
  }>;
  totalEstimatedCost: number;
  daily: TokenUsageDailySummary[];
}
