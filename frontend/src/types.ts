export type UILanguage = "en";

export interface QuizScore {
  correct: number;
  total: number;
}

export interface QuizQuestion {
  wordId: string;
  term: string;
  expectedAnswer: string;
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

export type QuizSessionSummary = Omit<QuizSession, "questions">;
