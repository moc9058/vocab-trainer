export type UILanguage = "en";

export interface Example {
  sentence: string;
  translation: string;
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
