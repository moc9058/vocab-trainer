export type UILanguage = "en";

/** Safely convert a translation that may be a string or object to a displayable string */
export function displayTranslation(t: string | Record<string, string> | null | undefined): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  return Object.values(t || {}).join("; ");
}

export interface Example {
  sentence: string;
  translation: string;
  segments?: { text: string; transliteration?: string; id?: string }[];
}

export interface QuizScore {
  correct: number;
  total: number;
}

export interface Meaning {
  partOfSpeech: string;
  text: Record<string, string>;
}

export interface QuizQuestion {
  wordId: string;
  term: string;
  definitions: Meaning[];
  transliteration?: string;
  examples?: Example[];
  userCorrect?: boolean;
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
}

export interface GrammarComponent {
  id: string;
  term: Record<string, string>;
  description?: Record<string, string>;
  examples?: GrammarExample[];
  words?: string[];
  level?: string;
  tags?: string[];
}

export interface GrammarItemDoc extends GrammarComponent {
  language: string;
  chapterNumber: number;
  subchapterId: string;
  subchapterTitle: Record<string, string>;
}

export interface GrammarQuizQuestion {
  componentId: string;
  displaySentence: string;
  chineseSentence: string;
  segments?: { text: string; pinyin?: string }[];
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
  chapterFilter?: number[];
  subchapterFilter?: string[];
  displayLanguage?: string;
  quizMode?: string;
}

export interface GrammarChapterInfo {
  chapterNumber: number;
  chapterTitle: Record<string, string>;
  subchapterCount: number;
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

export interface SentenceAnalysis {
  sentenceId: string;
  text: string;
  components: AnalysisComponent[];
}

export interface SentenceAnalysisResult {
  inputText: string;
  sentences: SentenceAnalysis[];
}

export interface TranslationResult {
  language: string;
  translation: string;
  grammarBreakdown: string;
  keyVocabulary: { term: string; meaning: string }[];
  alternativeExpressions: string[];
  culturalNotes: string;
  error?: string;
  analysis?: SentenceAnalysisResult;
}

export interface TranslationEntry {
  id: string;
  sourceText: string;
  targetLanguages: string[];
  results: TranslationResult[];
  createdAt: string;
}
