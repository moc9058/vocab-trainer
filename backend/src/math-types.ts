export type MathKind = "definition" | "calculation" | "proof";
export type MathDifficulty = "easy" | "standard" | "hard";
export interface MathChapter {
  id: string;
  number: number;
  title: string;
  versionId: string;
}
export type Ability = "concept" | "application" | "reasoning" | "modeling";
export type TaskKind = "prove" | "determine" | "compute" | "derive";
export interface SubjectProfile {
  version: string;
  subject: "mathematics" | "physics" | "economics";
  constraints: string[];
}
export interface CurriculumObjective {
  id: string;
  chapterId: string;
  statement: string;
  localizedStatements?: Record<string, string>;
  ability: Ability;
  supportedTaskKinds: TaskKind[];
  sourceRefs: { chapterId: string; section: string; heading: string }[];
  prerequisiteObjectiveIds: string[];
  requiredBackground: string[];
  successCriteria: { id: string; criterion: string }[];
  scopeConstraints: string[];
  commonErrors: string[];
  supersedes?: string[];
  status: "active" | "retired";
}
export interface Curriculum {
  schemaVersion: 2;
  bookId: string;
  revision: string;
  sourceLanguage: string;
  instructionLanguage: "en";
  sources: { chapterId: string; file: string; sha256: string }[];
  objectives: CurriculumObjective[];
}
export interface AssessmentPlan {
  primaryObjectiveId: string;
  chapterId: string;
  taskKind: TaskKind;
  seed: string;
  slot: "unseen" | "review" | "practice";
  reason?: string;
}
export interface ObjectiveProgress {
  schemaVersion: 2;
  objectiveId: string;
  presented: number;
  submitted: number;
  correct: number;
  partial: number;
  incorrect: number;
  skipped: number;
  lastPresentedAt?: string;
  lastGradedAt?: string;
  lastQuestionId?: string;
  lastTestId?: string;
  lastNumber?: number;
  lastVerdict?: "correct" | "partial" | "incorrect";
  assistanceStatus: "viewed" | "notReported" | "unknown";
}
export interface MathBook {
  id: string;
  subjectId: string;
  subjectTitle: string;
  title: string;
  language: string;
  revision: string;
  publicationId?: string;
  curriculumRevision?: string;
  subjectProfile?: SubjectProfile;
  chapters: MathChapter[];
}
export interface MathSource extends MathChapter {
  markdown: string;
  bookId: string;
}
export interface AssessmentCallMetric {
  stage: string;
  model?: string;
  inputBytes: number;
  elapsedMs: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
}
export interface MathQuestion {
  generationMetrics?: AssessmentCallMetric[];
  schemaVersion?: 2;
  primaryObjectiveId?: string;
  objectiveStatement?: string;
  supportingObjectiveIds?: string[];
  publicationId?: string;
  curriculumRevision?: string;
  difficulty?: MathDifficulty;
  difficultyPolicyVersion?: string;
  promptVersion?: string;
  taskKind?: TaskKind;
  ability?: Ability;
  responseFormat?: "written";
  sourceRefs?: { chapterId: string; heading: string }[];
  rubricItems?: { id: string; criterion: string; weight: number }[];
  answerSpec?: {
    mode: "proof" | "decision" | "exact" | "approximate" | "expression";
    domain: string;
    units?: string;
    tolerance?: { absolute?: number; relative?: number };
  };
  demandProfile?: Record<string, string>;
  assistanceStatus?: "viewed" | "notReported" | "unknown";
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
  gradingMetrics?: AssessmentCallMetric[];
  score?: number;
  items?: {
    id: string;
    status: "met" | "partial" | "unmet";
    evidence: string;
    feedback: string;
  }[];
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
  assistanceReporting?: boolean;
  assessmentFailure?: { metrics: AssessmentCallMetric[]; issues: unknown };
  assessmentVersion?: 2;
  taskKinds?: TaskKind[];
  publicationId?: string;
  curriculumRevision?: string;
  difficultyPolicyVersion?: string;
  promptVersion?: string;
  modelSelections?: Record<string, string>;
  pendingPlans?: AssessmentPlan[];
  evidenceNamespace?: string;
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
export type MathPublicQuestion = Omit<
  MathQuestion,
  "solution" | "rubric" | "rubricItems" | "demandProfile" | "generationMetrics"
> & {
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
