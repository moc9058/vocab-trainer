export interface Example {
  sentence: string;
  translation: string | Record<string, string>;
  segments?: { text: string; transliteration?: string; id?: string }[];
}

export interface Meaning {
  partOfSpeech: string;
  text: Record<string, string>;
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
  // Academic / Professional
  "Economics & Finance",
  "Politics & Government",
  "Science & Technology",
  "Law & Justice",
  "Medicine",
  "Education",
  "Business & Commerce",
  "Work & Career",
  // Culture & Society
  "Nature & Environment",
  "Arts & Entertainment",
  "Sports & Fitness",
  "Religion & Philosophy",
  "History",
  "Media & News",
  // Language Fundamentals
  "Language Fundamentals",
  // Other
  "Miscellaneous",
] as const;

export type Topic = (typeof TOPICS)[number];

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

export interface GrammarSubchapter {
  id: string;
  title: Record<string, string>;
  components: GrammarComponent[];
}

export interface GrammarChapter {
  chapter: string;
  chapterNumber: number;
  chapterTitle: Record<string, string>;
  language: string;
  subchapters: GrammarSubchapter[];
}

export interface GrammarProgress {
  timesSeen: number;
  timesCorrect: number;
  correctRate: number;
  lastReviewed: string;
  streak: number;
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

// ========== Translation ==========

export interface AnalysisComponent {
  componentId: string;
  surface: string;
  start?: number;
  end?: number;
  baseForm: string | null;
  reading: string | null;
  partOfSpeech: string;
  meaning: string;
  explanation: string;
}

export interface AnalysisChunk {
  chunkId: string;
  surface: string;
  start?: number;
  end?: number;
  meaning: string;
  components: AnalysisComponent[];
}

export interface SentenceAnalysis {
  sentenceId: string;
  text: string;
  language?: string;
  start?: number;
  end?: number;
  chunks: AnalysisChunk[];
  components?: AnalysisComponent[];
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
