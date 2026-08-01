export interface Example {
  /**
   * The underlying ExampleSentence document ID. Populated by `hydrateWords`
   * for persisted examples; absent on client-side drafts (e.g. a new example
   * being entered in a form) and on legacy embedded-example words.
   */
  id?: string;
  sentence: string;
  translation: string | Record<string, string>;
  segments?: { text: string; transliteration?: string; id?: string }[];
}

export interface ExampleSentence {
  id: string;
  sentence: string;
  translation: string | Record<string, string>;
  segments?: { text: string; transliteration?: string; id?: string }[];
  language: string;
  ownerWordId?: string;
  appearsInGrammarIds?: string[];
}

export interface Meaning {
  partOfSpeech: string;
  text: Record<string, string>;
  pinyins?: string[];
}

export interface HanjaReading {
  simplifiedChar: string;
  traditionalChar: string;
  hunEum: string[];
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
  hanjaReadings?: HanjaReading[];
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
  "Numbers, Time & Dates",
  "Social Interaction",
  // Academic / Professional
  "Economics & Finance",
  "Politics & Government",
  "Science & Technology",
  "Law & Justice",
  "Medicine",
  "Education",
  "Business & Commerce",
  "Work & Career",
  "Military & War",
  // Culture & Society
  "Nature & Environment",
  "Arts & Entertainment",
  "Sports & Fitness",
  "Religion & Philosophy",
  "History",
  "Media & News",
  "Emotions & Psychology",
  // Language Fundamentals
  "Language Fundamentals",
  // Other
  "Miscellaneous",
] as const;

export type Topic = (typeof TOPICS)[number];

/** Meta-group bucket. Absent = "A" (the universe of all items).
 *  "B" = the not-yet-memorized subset, drilled by the dedicated Group B quiz. */
export type GroupCategory = "A" | "B";

export interface WordGroup {
  id: string;
  language: string;
  name: string;
  wordIds: string[];
  createdAt: string;
  order?: number;
  /** Meta-group. Absent = "A" (all words). "B" = not-yet-memorized subset. */
  category?: GroupCategory;
}

export interface WordDraft {
  id: string;
  language: string;
  term: string;
  transliteration?: string;
  /** Usually one language only — smart-add fills the rest when the draft is promoted. */
  definitions?: Meaning[];
  /** Inline raw examples — drafts are NOT normalized into example_sentences.
   *  `segments` carries the chip segmentation (Chinese): segment TEXTS in
   *  sentence order (plain strings, unlike Example.segments objects). Becomes
   *  smart-add's `userSplits` on promotion. */
  examples?: { sentence: string; translation: string; segments?: string[] }[];
  level?: string;
  topics?: string[];
  /** Original upload filename, for traceability. */
  sourceImage?: string;
  /** Set at bulk-upload time when a live word with the same `term` already exists in the DB. */
  duplicate?: boolean;
  createdAt: string;
}

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
  hanjaReadings?: HanjaReading[];
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
  groupWeights?: Record<string, number>;
  groupMembership?: Record<string, string[]>;
  /** Weight for the "already-correct" (mastered) bucket. When set, mastered words are pulled
   *  out of the normal pool and drawn as one bucket peer to the groups (0 = exclude them). */
  correctWeight?: number;
  /** Word IDs classified as mastered when the session was built (or on-demand mid-session). */
  correctMembership?: string[];
  pendingWordIds?: string[];
  questionTarget?: number;
  flaggedOnly?: boolean;
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
  translation: string | Record<string, string>;
  transliteration?: string;
  segments?: { text: string; transliteration?: string; id?: string }[];
  /** Input-only: user-specified segment splits (spaces in sentence field), never persisted. */
  userSplits?: string[];
}

export interface Grammar {
  id: string;
  language: string;
  statement: string;
  /** Pinyin of `statement`, Chinese characters only (Chinese language). */
  transliteration?: string;
  descriptions: Meaning[];
  /** @deprecated Use `exampleIds` + the `example_sentences` collection. Kept as a transitional fallback until all docs are migrated. */
  examples?: GrammarExample[];
  exampleIds?: string[];
  words?: string[];
  level?: string;
  tags?: string[];
}

export interface GrammarDraft {
  id: string;
  language: string;
  statement: string;
  /** Pinyin of `statement`, Chinese characters only (Chinese language). */
  transliteration?: string;
  descriptions: Meaning[];
  /** Inline raw examples — drafts are NOT normalized into example_sentences. */
  examples?: GrammarExample[];
  level?: string;
  tags?: string[];
  /** Original upload filename, for traceability. */
  sourceImage?: string;
  /** Set at bulk-upload time when a live grammar item with the same `statement` already exists in the DB. */
  duplicate?: boolean;
  createdAt: string;
}

export interface GrammarGroup {
  id: string;
  language: string;
  name: string;
  grammarIds: string[];
  createdAt: string;
  /** Meta-group. Absent = "A" (all grammar). "B" = not-yet-memorized subset. */
  category?: GroupCategory;
}

export interface GrammarProgress {
  timesSeen: number;
  timesCorrect: number;
  correctRate: number;
  lastReviewed: string;
  streak: number;
}

export interface GrammarQuizQuestion {
  grammarId: string;
  /** The grammar element shown as-is as the question; descriptions are revealed on answer. */
  statement: string;
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
  groupFilter?: string[];
  groupWeights?: Record<string, number>;
  groupMembership?: Record<string, string[]>;
  /** Weight for the "already-correct" (mastered) bucket (0 = exclude mastered grammar items). */
  correctWeight?: number;
  /** Grammar IDs classified as mastered when the session was built (or on-demand mid-session). */
  correctMembership?: string[];
}

// ========== Combined Quiz (words + grammar) ==========

export interface CombinedQuizWordQuestion extends QuizQuestion {
  kind: "word";
}

export interface CombinedQuizGrammarQuestion extends GrammarQuizQuestion {
  kind: "grammar";
}

export type CombinedQuizQuestion = CombinedQuizWordQuestion | CombinedQuizGrammarQuestion;

// How often word questions are drawn vs grammar questions (proportional, like group weights).
export interface CombinedDomainWeights {
  word: number;
  grammar: number;
}

export interface CombinedQuizSession {
  sessionId: string;
  language: string;
  startedAt: string;
  completedAt?: string;
  status: "in-progress" | "completed";
  score: QuizScore;
  questions: CombinedQuizQuestion[];
  domainWeights: CombinedDomainWeights;
  // Question count at start — retry re-queues grow `questions`, so the UI shows X / initialTotal.
  initialTotal: number;
  wordGroupWeights?: Record<string, number>;
  wordGroupMembership?: Record<string, string[]>;
  grammarGroupWeights?: Record<string, number>;
  grammarGroupMembership?: Record<string, string[]>;
  /** Top-level weight for the "already-correct" (mastered) bucket, peer to word/grammar domains
   *  (0 = exclude mastered items). */
  correctWeight?: number;
  /** Word/grammar IDs classified as mastered when the session was built (or on-demand). */
  correctMembership?: { wordIds: string[]; grammarIds: string[] };
  flaggedOnly?: boolean;
  /**
   * Order the whole session by one uniform shuffle of the word+grammar union instead of
   * merging the two domains by weight. `weightedMerge` picks a BUCKET per draw, so at 1:1
   * a small grammar pool drains first and clusters at the front — not what "random" means.
   * Sticky on the session because resume re-orders the unanswered tail too.
   */
  randomOrder?: boolean;
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

export interface AnalysisChunk {
  chunkId: string;
  surface: string;
  meaning: string;
  components: AnalysisComponent[];
}

export interface SentenceAnalysis {
  sentenceId: string;
  text: string;
  meaning?: string;
  chunks: AnalysisChunk[];
  components?: AnalysisComponent[];
}

export interface SentenceAnalysisResult {
  sentences: SentenceAnalysis[];
}

export interface TranslationPassage {
  sentenceIds: string[];
  translation: string;
}

export interface TranslationResult {
  language: string;
  error?: string;
  passages?: TranslationPassage[];
  analysis?: SentenceAnalysisResult;
}

export interface TranslationEntry {
  id: string;
  sourceLanguage: string;
  sourceText: string;
  /** Optional user-provided situation/register hint reflected in translations. */
  context?: string;
  targetLanguages: string[];
  results: TranslationResult[];
  createdAt: string;
}

// ========== Speaking & Writing ==========

export interface CorrectionItem {
  original: string;
  corrected: string;
  explanation: string;
  severity: "error" | "improvement" | "style";
}

export interface CorrectionResult {
  originalText: string;
  correctedText: string;
  corrections: CorrectionItem[];
  overallFeedback: string;
}

export interface SpeakingWritingEntry {
  inputText: string;
  result: CorrectionResult;
  createdAt: string;
}

export interface SpeakingWritingSession {
  sessionId: string;
  language: string;
  mode: "speaking" | "writing";
  useCase: string;
  startedAt: string;
  status: "in-progress" | "completed";
  corrections: SpeakingWritingEntry[];
  currentIndex: number;
  expressionQuiz?: ExpressionQuizSubsession;
}

// ========== Expressions ==========

export interface Expression {
  id: string;
  language: string;
  phrase: string;
  context: string;
  description?: string;
  purpose?: ("speaking" | "writing")[];
  groupIds?: string[];
}

export interface ExpressionGroup {
  id: string;
  language: string;
  name: string;
  expressionIds: string[];
  createdAt: string;
}

export interface ExpressionQuizQuestion {
  expressionId: string;
  phrase: string;
  context: string;
  description?: string;
  userInput?: string;
  correctionResult?: CorrectionResult;
  userCorrect?: boolean;
}

export interface ExpressionQuizSubsession {
  purposeFilter?: ("speaking" | "writing")[];
  startedAt: string;
  completedAt?: string;
  status: "in-progress" | "completed";
  score: QuizScore;
  questions: ExpressionQuizQuestion[];
  groupFilter?: string[];
}

// ========== Expression recall quiz (flashcard) ==========
//
// Distinct from ExpressionQuizSubsession above, which is the LLM-graded WRITING
// quiz: there you compose a sentence and get it corrected. This one is plain
// recall — see one side, self-grade the other — and so lives in its own
// collection rather than riding on the speaking&writing session document.

/** Which face of the card is the prompt. `phrase-to-context` is recognition
 *  ("what does this mean / when is it used?"); the reverse is production recall
 *  ("in this situation, what do you say?"). */
export type ExpressionQuizDirection = "phrase-to-context" | "context-to-phrase";

export interface ExpressionRecallQuestion {
  expressionId: string;
  /** The prompt face, denormalized so the question renders before hydration. */
  prompt: string;
  userCorrect?: boolean;
}

export interface ExpressionRecallSession {
  sessionId: string;
  language: string;
  startedAt: string;
  completedAt?: string;
  status: "in-progress" | "completed";
  score: QuizScore;
  questions: ExpressionRecallQuestion[];
  direction: ExpressionQuizDirection;
  purposeFilter?: ("speaking" | "writing")[];
  groupFilter?: string[];
  groupWeights?: Record<string, number>;
  /** groupId -> expressionIds, so resume can re-weight the unanswered tail. */
  groupMembership?: Record<string, string[]>;
}

// ========== Token Usage Metrics ==========

export interface TokenUsageRecord {
  id: string;
  timestamp: string;
  model: string;
  caller: string;
  route: string;

  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  thoughtsTokens?: number;
}

export interface TokenUsageDailySummary {
  model: string;
  date: string;
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;

  byRoute: Record<string, {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
}

export interface TokenCostRate {
  input: number;
  cachedInput: number;
  output: number;
  thoughtsInput: number;
}

export interface TokenCostConfig {
  models: Record<string, TokenCostRate>;
  updatedAt: string;
}

export interface GrammarSettings {
  defaultDefinitionLanguage: string;
}

export interface UsageMetricsSummary {
  period: { from: string; to: string };
  byModel: Record<string, {
    totalCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    thoughtsTokens: number;
    estimatedCost: number;
  }>;
  totalEstimatedCost: number;
  daily: TokenUsageDailySummary[];
}

// ========== Import (analyze an external article into words + grammar) ==========

export interface ImportSentence {
  /** Position across the whole article (0-based); assigned server-side. */
  index: number;
  text: string;
  translation?: string;
}

export interface ImportParagraph {
  sentences: ImportSentence[];
}

export interface ImportExtractedWord {
  term: string;
  transliteration?: string;
  /** Short gloss, for the review list only — the real definitions come from smart-add. */
  meaning?: string;
  /** The sentence the word occurs in; it becomes the word's example sentence. */
  sentenceIndex: number;
}

export interface ImportExtractedGrammar {
  /** Pattern notation, e.g. "～的话：〜なら". */
  statement: string;
  description: string;
  sentenceIndex: number;
}

export interface ImportAnalysisResult {
  paragraphs: ImportParagraph[];
  words: ImportExtractedWord[];
  grammar: ImportExtractedGrammar[];
}

// ---------- Import sessions (a paused, resumable review of one article) ----------

/**
 * `queued` means "handed to the client-side add queue" — it is NOT proof of a
 * successful write, which is why it renders as unverified rather than a ✓.
 * `duplicate` is a 409: the item IS in the DB, but the queue's group work never
 * ran, so no group membership may be claimed. `skipped` covers both a user
 * deletion and a row consumed by a merge/split (see `supersededByIds`).
 */
export type ImportItemStatus =
  | "pending"
  | "queued"
  | "registered"
  | "duplicate"
  | "failed"
  | "skipped";

/** One destination's registration state. Terminal values mirror `ImportItemStatus`;
 *  `pending`/`skipped` are row-level facts and never appear here. */
export interface ImportRegistrationState {
  status: "queued" | "registered" | "duplicate" | "failed";
  error?: string;
  rescuedAsDraft?: boolean;
}

interface ImportItemBase {
  /** Stable across edits, merges and reloads; assigned client-side. */
  id: string;
  sentenceIndex: number;
  /** Fractional, so a split can insert its parts between neighbours without renumbering. */
  order: number;
  status: ImportItemStatus;
  /** Which destination the in-flight (or last) registration was aimed at. A row can
   *  be added to its Group A destination and its Group B destination independently,
   *  so `status` alone cannot say which of the two buttons is spinning or failed. */
  target?: "A" | "B";
  /**
   * Per-destination registration state — the real record; `status`/`target`/`error`
   * above are a DERIVED summary of it (`summarizeRegistrations`), kept because the
   * progress counter, `isLocked`, the load-time reconciliation and the backend's
   * `registeredCount` all read them.
   *
   * It exists because Group A and Group B are independent writes that must be able to
   * be in flight AT THE SAME TIME. A single status could only describe one of them, so
   * pressing A locked B out until A settled, and "A failed while B succeeded" had no
   * representation at all.
   */
  registrations?: Partial<Record<"A" | "B", ImportRegistrationState>>;
  /** `gap` rows are not proposals — they are the characters the analysis left
   *  uncovered, materialized so every character of every sentence has a row. They
   *  carry no reading or meaning, which is why they are flagged for review. */
  origin: "llm" | "merge" | "split" | "manual" | "gap";
  /** Rows this one was derived from — drives the hint line and the undo. */
  sourceIds?: string[];
  /** Set on the rows a merge/split consumed. They stay in `items` as `skipped`
   *  tombstones so the operation can be undone and the session remains a complete
   *  record of what was proposed and what the user did with it. */
  supersededByIds?: string[];
  error?: string;
  /** The queue rescues a failed create into a draft — surfaced so a failed row can
   *  say the input was not lost. */
  rescuedAsDraft?: boolean;
}

export interface ImportWordItem extends ImportItemBase {
  kind: "word";
  term: string;
  transliteration?: string;
  meaning?: string;
  /** Already in the DB — such a word is never re-created, only given group membership.
   *  Set from the analysis-time lookup, from a registration, or propagated from a
   *  sibling row that registered the same term. */
  existingWordId?: string;
}

export interface ImportGrammarItem extends ImportItemBase {
  kind: "grammar";
  statement: string;
  description: string;
  /** The grammar item this row registered (or that a sibling row with the identical
   *  statement registered). Grammar has no analysis-time existence check, so unlike
   *  `existingWordId` this is only ever learned from a registration in this session. */
  existingGrammarId?: string;
}

export type ImportItem = ImportWordItem | ImportGrammarItem;

/**
 * One article being worked through. `items` is the single working copy — the raw
 * `ImportAnalysisResult` words/grammar arrays are flattened into it at creation and
 * are NOT stored separately, so there is no drift between what the LLM extracted and
 * what the user edited. `paragraphs` keeps the article structure for the review UI.
 */
export interface ImportSession {
  id: string;
  /** Backend full-name language, e.g. "chinese". */
  language: string;
  /** Leading slice of `text`, for the resume list. */
  title: string;
  text: string;
  paragraphs: ImportParagraph[];
  items: ImportItem[];
  /** Group A destinations (per-domain, as Group A groups are domain-specific). */
  wordGroupId?: string;
  grammarGroupId?: string;
  /** Group B is cross-domain and joined by NAME across both group collections. */
  groupBNames: string[];
  focusedSentenceIndex: number;
  status: "in-progress" | "done";
  createdAt: string;
  updatedAt: string;
}

/** Row shape for the resume list — omits `text`/`paragraphs`/`items` so listing
 *  many sessions stays cheap. */
/** The article quizzes' pool: every entity the saved import sessions of one language
 *  point at, deduped across articles. Which of these belong to Group A vs Group B is
 *  resolved against the group documents, not stored on the sessions. */
export interface ImportQuizPool {
  wordIds: string[];
  grammarIds: string[];
}

export interface ImportSessionSummary {
  id: string;
  language: string;
  title: string;
  totalCount: number;
  registeredCount: number;
  status: "in-progress" | "done";
  createdAt: string;
  updatedAt: string;
}

// ========== LLM model configuration ==========

/** The two model tiers `llm.ts` has always had: MINI for cheap structural work,
 *  FULL for reasoning-heavy work. */
export type LLMTier = "mini" | "full";

/** User-editable model assignments, stored in Firestore `config/llm_models`.
 *
 *  Deliberately a SEPARATE document from `config/llm`: that one holds
 *  `OPENAI_API_KEY` and is overwritten wholesale by
 *  `migrate-llm-config-to-firestore.ts` on every `./deploy.sh --llm`, so a
 *  catalog living there would be both leakable through a GET and wiped by the
 *  next deploy. */
export interface LLMModelConfig {
  /** Model names the user has registered, in display order. */
  catalog: string[];
  /** Tier fallbacks. Absent = fall back to env / `config/llm`. */
  defaults: { mini?: string; full?: string };
  /** `LLMFeature.key` -> model name. Absent = use that feature's tier default. */
  features: Record<string, string>;
  updatedAt: string;
}

/** Where a resolved model came from — surfaced in the settings UI so the user
 *  can tell an explicit choice from an inherited one. */
export type LLMModelSource = "feature" | "default" | "env";
