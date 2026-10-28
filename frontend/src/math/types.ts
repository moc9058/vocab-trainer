/** Mathematics API contract. Public DTOs never include solutions implicitly. */
export type Capability = "recognize" | "apply" | "prove";
export interface CapabilityRef {
  conceptId: string;
  capability: Capability;
}
export interface Dependencies {
  allOf: CapabilityRef[];
  anyOf: { id: string; priority: number; requires: CapabilityRef[] }[];
}
export interface SourcePathNode {
  sourceNodeId: string;
  kind: string;
  printedLabel?: string;
  title: string;
}
export interface Citation {
  citationId: string;
  conceptId: string;
  conceptRevisionId: string;
  sourceOccurrenceId: string;
  origin: "source" | "derived" | "pedagogical" | "author";
  subjectTitle: string;
  bookTitle?: string;
  edition?: string;
  sourceRevisionId?: string;
  sourcePath: SourcePathNode[];
  itemKind: string;
  printedItemLabel?: string;
  itemTitle: string;
  pdfPageStart?: number;
  pdfPageEnd?: number;
  printedPageLabel?: string;
  blockIds: string[];
  hierarchyStatus: "verified" | "unresolved" | "not-applicable";
  supportingCitationIds: string[];
}
export interface Concept {
  id: string;
  subjectId: string;
  ownerUnitId: string;
  revisionId: string;
  title: string;
  kind: string;
  readiness: "ready" | "blocked";
  statement: string;
  conditions: string;
  capabilities: Partial<Record<Capability, { prerequisites: Dependencies }>>;
  provideable: boolean;
  requiredToUseWhenGiven: CapabilityRef[];
  related: CapabilityRef[];
  recommended: CapabilityRef[];
  citations: Citation[];
  sourceArtifactHash: string;
  blockIds: string[];
}
export interface Objective {
  id: string;
  unitId: string;
  description: string;
  assessedCapabilities: CapabilityRef[];
  additionalPrerequisites: Dependencies;
  assessmentBlockIds: string[];
  difficultyRange: [number, number];
  proofRequirement: "none" | "sketch" | "complete";
  proofSupport: {
    coverage: "none" | "sketch" | "complete";
    blockIds: string[];
  };
  readiness: "ready" | "blocked" | "reference-only";
}
export interface Unit {
  id: string;
  subjectId: string;
  revisionId: string;
  title: string;
  contentLanguage: string;
  sourceArtifactHash: string;
  provenanceHash: string;
  reviewHash: string;
  objectiveIds: string[];
  conceptIds: string[];
  blocks: {
    id: string;
    kind: string;
    anchor: string;
    markdown: string;
    provenanceId: string;
  }[];
  problemFamilies: {
    id: string;
    objectiveIds: string[];
    specificationBlockId: string;
  }[];
  proofCoverage: "none" | "sketch" | "complete";
  status: "ready" | "partial" | "reference-only";
}
export interface CurriculumNode {
  eligibleObjectiveCount?: number;
  id: string;
  subjectId: string;
  parentId: string | null;
  ancestorIds: string[];
  kind: string;
  title: string;
  order: number;
  unitIds: string[];
}
export interface Subject {
  id: string;
  title: string;
  rootNodeId: string;
  order: number;
  foundationProfileIds: string[];
}
export interface FoundationProfile {
  id: string;
  title: string;
  revision: string;
  acceptedCapabilities: CapabilityRef[];
  sourceDescription: string;
}
export interface Catalog {
  authoringPaths?: Record<string, string>;
  id: string;
  schemaVersion: 1;
  parserVersion: string;
  subjects: Subject[];
  nodes: CurriculumNode[];
  concepts: Concept[];
  units: Unit[];
  objectives: Objective[];
  profiles: FoundationProfile[];
}
export interface ScopeRequest {
  subjectId: string;
  selectedNodeIds: string[];
  excludedConceptIds: string[];
  excludedObjectiveIds: string[];
  objectiveCapabilities: Capability[];
  mode: "strict" | "prerequisites" | "provided";
  profileIds: string[];
  difficulty: number;
  questionCount: number;
  responseLanguage: "en" | "ja" | "ko";
  answerFormats: AnswerFormat[];
}
export type AnswerFormat =
  "numeric" | "expression" | "text" | "proof" | "choice";
export interface QuestionPlan {
  seed: string;
  id: string;
  targetObjectiveIds: string[];
  allowedCapabilities: CapabilityRef[];
  providedCapabilities: CapabilityRef[];
  mustEstablish: CapabilityRef[];
  mayAssume: CapabilityRef[];
  difficulty: number;
  answerFormat: AnswerFormat;
}
export interface Scope {
  catalogId: string;
  request: ScopeRequest;
  targetObjectiveIds: string[];
  targets: CapabilityRef[];
  prerequisites: CapabilityRef[];
  baseline: CapabilityRef[];
  givens: CapabilityRef[];
  requiredAcceptance: string[];
  branches: { owner: string; alternativeId: string }[];
  excluded: { objectiveId: string; reason: string; missing: CapabilityRef[] }[];
  paths: Record<string, string[]>;
  plans: QuestionPlan[];
  coverage: { objectiveId: string; plannedQuestions: number }[];
}
export interface ScopePreview extends Scope {
  id: string;
  scopeHash: string;
  expiresAt: number;
}
export interface Rubric {
  criterionId: string;
  objectiveId: string;
  points: number;
  description: string;
  requiredStepIds: string[];
}
export interface MathSolution {
  usedKnowledge: {
    conceptId: string;
    revisionId: string;
    citationIds: string[];
    role: "target" | "prerequisite" | "foundation" | "given";
  }[];
  strategyMarkdown: string;
  steps: {
    id: string;
    citationIds: string[];
    uses: CapabilityRef[];
    applicabilityMarkdown: string;
    explanationMarkdown: string;
  }[];
  finalAnswerMarkdown: string;
  checksMarkdown: string;
}
export interface Candidate {
  status: "candidate";
  promptMarkdown: string;
  answerFormat: AnswerFormat;
  targetObjectiveIds: string[];
  prerequisitesUsed: CapabilityRef[];
  foundationUsed: CapabilityRef[];
  givens: {
    capability: CapabilityRef;
    promptBlockId: string;
    statementMarkdown: string;
    conditionsMarkdown: string;
  }[];
  solution: MathSolution;
  rubric: Rubric[];
  estimatedDifficulty: {
    level: number;
    reasoningDepth: number;
    algebraLoad: number;
    abstraction: number;
    proofDemand: number;
    integrationCount: number;
  };
  expectedMinutes: number;
  numericCheck: {
    expected: number;
    absoluteTolerance: number;
    unit: string;
  } | null;
}
export interface PublicQuestion {
  id: string;
  ordinal: number;
  promptMarkdown: string;
  answerFormat: AnswerFormat;
  targetObjectiveIds: string[];
  difficulty: number;
  validationStatus: "ai-validated";
  contentHash: string;
}
export interface StoredSolution {
  candidate: Candidate;
  citations: Citation[];
  citationRegistry?: Citation[];
  validation: Record<string, unknown>;
}
export interface GradeCriterion {
  criterionId: string;
  awardedPoints: number;
  maxPoints: number;
  feedback: string;
  evidenceRanges: { start: number; end: number; quote: string }[];
  citationIds: string[];
}
export interface Assessment {
  citations?: Citation[];
  state: "graded" | "needs_review";
  criteria: GradeCriterion[];
  outsideMethodUsed: boolean;
  objectiveEvidence: { objectiveId: string; demonstrated: boolean }[];
  correctnessScore: number;
  gradeSource: "ai" | "deterministic" | "self" | "override";
  feedback: string;
}
export interface Attempt {
  sequence?: number;
  ordinal?: number;
  questionOrdinal?: number;
  id: string;
  questionId: string;
  sittingId: string;
  answerText: string;
  paper: boolean;
  skipped: boolean;
  assistanceUsed: boolean;
  assessmentState:
    "submitted" | "grading" | "graded" | "needs_review" | "grading_failed";
  gradeVersion: number;
  assessment: Assessment | null;
  history: Assessment[];
  submittedAt: number;
  jobId?: string;
}
export interface Draft {
  questionId: string;
  answerText: string;
  revision: number;
  savedAt: number;
}
export interface Sitting {
  startSequence?: number;
  endSequence?: number | null;
  id: string;
  state: "active" | "ended";
  startedAt: number;
  endedAt: number | null;
  attemptIds: string[];
  review: {
    state: "idle" | "active" | "completed";
    revision: number;
    cursor: number;
    startSequence?: number;
    endSequence?: number | null;
    currentAttemptId?: string | null;
    attemptIds: string[];
  };
}
export interface MathTest {
  generationMode?: "finite" | "continuous";
  questionLimit?: number | null;
  generationState?: "idle" | "queued" | "running" | "failed";
  generatedCount?: number;
  answeredCount?: number;
  invalidCount?: number;
  currentQuestionId?: string | null;
  pendingGenerationJobId?: string | null;
  generationEpoch?: number;
  purpose?: "study" | "verification";
  id: string;
  schemaVersion: 1 | 2;
  catalogId: string;
  scopeHash: string;
  config: ScopeRequest | ScopeRequestV2;
  state:
    | "generating"
    | "generation_failed"
    | "ready"
    | "in_progress"
    | "completed"
    | "cancelled";
  revision: number;
  generationJobId: string;
  currentSittingId: string | null;
  questionIds: string[];
  answeredQuestionIds: string[];
  invalidQuestionIds: string[];
  revealedQuestionIds: string[];
  createdAt: number;
  updatedAt: number;
}
export interface TestView extends MathTest {
  questions: PublicQuestion[];
  attempts: Attempt[];
  drafts: Draft[];
  sitting: Sitting | null;
  score: number;
  maxScore: number;
  pendingGrades: number;
  scopeSummary: { targets: number; prerequisites: number; baseline: number };
  coverage: Scope["coverage"];
}
export interface MathJob {
  id: string;
  type: "generate" | "grade";
  testId: string;
  attemptId: string | null;
  state:
    "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "cancelled";
  sequence: number;
  generation: number;
  cursor: number;
  stage: "generate" | "solve" | "validate" | "grade";
  candidateAttempt: number;
  transportAttempts: number;
  nextWakeAt: number;
  lease: { token: string; expiresAt: number } | null;
  frozenConfig: {
    schemaVersion: 1;
    promptVersion: string;
    models: { generate: string; validate: string; grade: string };
  };
  calls: number;
  tokens: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Creation contract; v1 ScopeRequest remains for immutable historic snapshots. */
export interface ScopeRequestV2 {
  schemaVersion: 2;
  subjectId: string;
  selectedNodeIds: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  questionCount?: number;
  responseLanguage: "en" | "ja" | "ko";
}
export interface ScopePreviewV2 {
  schemaVersion: 2;
  id?: string;
  previewId: string;
  scopeHash: string;
  catalogId: string;
  curriculumHash: string;
  eligibleObjectiveCount: number;
  compactSummary: unknown;
  expiresAt: number;
}
