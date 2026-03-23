export interface Example {
  sentence: string;
  translation: string;
  segments?: { text: string; transliteration?: string; id?: string }[];
}

export interface Word {
  id: string;
  term: string;
  transliteration?: string;
  definition: Record<string, string>;
  grammaticalCategory: string;
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
  // Culture & Society
  "Arts & Entertainment",
  "Sports & Fitness",
  "Religion & Philosophy",
  "History",
  "Media & News",
  // Language Fundamentals
  "Language Fundamentals",
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
  definition: Record<string, string>;
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
  description: Record<string, string>;
  examples: GrammarExample[];
  relatedWordIds?: string[];
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
