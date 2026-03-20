export interface Example {
  sentence: string;
  translation: string;
  segments?: { text: string; transliteration?: string }[];
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
