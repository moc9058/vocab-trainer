export type UILanguage = "en";

export interface Example {
  sentence: string;
  translation: string;
  segments?: { text: string; pinyin?: string }[];
}

export interface QuizScore {
  correct: number;
  total: number;
}

export interface QuizQuestion {
  wordId: string;
  term: string;
  expectedAnswer: string;
  transliteration?: string;
  japaneseDefinition?: string;
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
  definition: Record<string, string>;
  grammaticalCategory: string;
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
