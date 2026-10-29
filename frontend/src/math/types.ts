export type MathKind = "definition" | "calculation" | "proof";
export type MathDifficulty = "easy" | "standard" | "hard";
export interface MathChapter {
  id: string;
  number: number;
  title: string;
  versionId: string;
}
export interface MathBook {
  id: string;
  subjectId: string;
  subjectTitle: string;
  title: string;
  language: string;
  revision: string;
  chapters: MathChapter[];
}
export interface MathSource extends MathChapter {
  markdown: string;
  bookId: string;
}
export interface MathQuestion {
  number?: number;
  id: string;
  chapterId: string;
  heading: string;
  kind: MathKind;
  prompt: string;
  solution: string;
  rubric: string;
}
export interface MathGrade {
  verdict: "correct" | "partial" | "incorrect";
  feedback: string;
}
export interface MathAnswer {
  submitted?: boolean;
  text: string;
  operationId: string;
  grade?: MathGrade;
}
export interface MathTest {
  mode?: "fixed" | "continuous";
  phase?: "ready" | "question" | "feedback";
  currentQuestionId?: string;
  generatedCount?: number;
  stats?: {
    answered: number;
    correct: number;
    partial: number;
    incorrect: number;
  };
  id: string;
  book: MathBook;
  chapterIds: string[];
  sourceVersionIds: string[];
  count: number;
  kinds: MathKind[];
  difficulty: MathDifficulty;
  status:
    | "created"
    | "generating"
    | "generation_failed"
    | "active"
    | "paused"
    | "completed";
  questions: MathQuestion[];
  answers: Record<string, MathAnswer>;
  draft: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  lock?: { token: string; until: number };
  error?: string;
}
export type MathPublicQuestion = Omit<MathQuestion, "solution" | "rubric"> & {
  solution?: string;
  rubric?: string;
};
export type MathPublicTest = Omit<MathTest, "questions" | "lock"> & {
  questions: MathPublicQuestion[];
};

export interface MathHistoryItem {
  question: MathPublicQuestion;
  answer?: MathAnswer;
  number: number;
}
export interface MathHistoryPage {
  items: MathHistoryItem[];
  nextCursor: number | null;
}
