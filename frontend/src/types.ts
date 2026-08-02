export type UILanguage = "en";

/** Safely convert a translation that may be a string or object to a displayable string */
export function displayTranslation(t: string | Record<string, string> | null | undefined): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  return Object.values(t || {}).join("; ");
}

export interface Example {
  /** ExampleSentence doc ID when hydrated from the backend; absent on fresh drafts. */
  id?: string;
  sentence: string;
  translation: string | Record<string, string>;
  segments?: { text: string; transliteration?: string; id?: string }[];
  /** Input-only: user-specified segment splits (spaces in sentence field), never persisted. */
  userSplits?: string[];
}

export interface QuizScore {
  correct: number;
  total: number;
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

export interface QuizQuestion {
  wordId: string;
  term: string;
  definitions: Meaning[];
  transliteration?: string;
  examples?: Example[];
  userCorrect?: boolean;
  hanjaReadings?: HanjaReading[];
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

export interface Word {
  id: string;
  term: string;
  transliteration?: string;
  definitions: Meaning[];
  examples: Example[];
  topics: string[];
  level?: string;
  notes?: string;
  hanjaReadings?: HanjaReading[];
}

/** Meta-group bucket. Absent = "A" (the universe of all items).
 *  "B" = the not-yet-memorized subset, drilled by the dedicated Group B quiz. */
export type GroupCategory = "A" | "B";

export function groupCategory(g: { category?: GroupCategory }): GroupCategory {
  return g.category ?? "A";
}

export function categoryGroups<T extends { category?: GroupCategory }>(
  groups: T[],
  cat: GroupCategory
): T[] {
  return groups.filter((g) => groupCategory(g) === cat);
}

export interface WordGroup {
  id: string;
  language: string;
  name: string;
  wordIds: string[];
  createdAt: string;
  /** Priority AND display order; 0 is the highest. See `firestore.ts:compareWordGroups`. */
  order?: number;
  /** Meta-group. Absent = "A" (all words). "B" = not-yet-memorized subset. */
  category?: GroupCategory;
}

/** Per-group effect of one normalize run. Mirrors `backend/src/types.ts`. */
export interface GroupNormalizeChange {
  groupId: string;
  name: string;
  /** 0-based rank among category-A groups. */
  priority: number;
  /** Duplicate memberships dropped — the word is kept in a higher-priority group. */
  removedCount: number;
  /** Ungrouped words absorbed. Only ever > 0 for the top-priority group. */
  addedCount: number;
  before: number;
  after: number;
}

export interface GroupNormalizeResult {
  language: string;
  /** false for a dry run and for a language with no category-A groups. */
  applied: boolean;
  groupCount: number;
  /** null iff the language has no category-A group to absorb into. */
  topGroup: { id: string; name: string } | null;
  totalWords: number;
  /** DISTINCT words that lost at least one lower-priority membership. */
  movedWords: number;
  addedWords: number;
  unchangedGroups: number;
  changes: GroupNormalizeChange[];
  /** Post-state list (BOTH categories, priority order). Present only when `applied`. */
  groups?: WordGroup[];
}

/**
 * The highest-priority **category A** word group: the default registration target for
 * every "add a word" flow (drafts, segment chips, smart add, the article importer),
 * AND the group `POST /api/vocab/:language/groups/normalize` files ungrouped words
 * into. One definition, so the button's absorb target and the default add target can
 * never disagree.
 *
 * This is the FIRST group in the server's arranged order — `getWordGroups` sorts by
 * `order` (written by the group manager's drag) and falls back to newest-created
 * first — NOT "the most recently created group". Dragging a group to the top of the
 * manager therefore changes the default add target too. Until a language is ever
 * dragged no `order` exists anywhere and the newest-first fallback reproduces the
 * old `createdAt`-max behaviour exactly.
 *
 * PRECONDITION: `groups` must still be in server order. Do not sort it locally.
 * Group B groups are never an implicit default; they are only ever picked explicitly.
 */
export function defaultWordGroup(groups: WordGroup[]): WordGroup | undefined {
  return categoryGroups(groups, "A")[0];
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
   *  sentence order (plain strings, unlike Example.segments objects). Re-rendered
   *  as spaced chips in the review modal → smart-add's `userSplits` on save. */
  examples?: { sentence: string; translation: string; segments?: string[] }[];
  level?: string;
  topics?: string[];
  /** Original upload filename, for traceability. */
  sourceImage?: string;
  /** Set at bulk-upload time when a live word with the same `term` already exists in the DB. */
  duplicate?: boolean;
  createdAt: string;
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
  /** @deprecated Use `exampleIds` + the `example_sentences` collection. Kept as a transitional fallback. */
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

export interface GrammarSettings {
  defaultDefinitionLanguage: string;
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

/**
 * Most recently created **category A** group (by `createdAt`), or undefined if there
 * is none.
 *
 * Deliberately NOT the priority-based `defaultWordGroup`: `GrammarGroup` has no
 * `order` field, grammar groups are not drag-reorderable (`GroupPickerModal` gates
 * reordering on `kind === "word"`), and grammar is exempt from the one-item-one-A-group
 * rule — so there is no grammar priority to read. Keep the two asymmetric rather than
 * inventing an ordering the user cannot see or set.
 */
export function latestGrammarGroup(groups: GrammarGroup[]): GrammarGroup | undefined {
  return categoryGroups(groups, "A").reduce<GrammarGroup | undefined>(
    (latest, g) => (!latest || g.createdAt > latest.createdAt ? g : latest),
    undefined
  );
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

/**
 * The mixed A+B quiz's UNFOLDED weight inputs: the A↔B category ratio and, within each
 * category, its own word↔grammar ratio.
 *
 * Ordering never reads this — it uses only the folded `domainWeights`/`*GroupWeights` that
 * `utils/quizGroupScope.ts:foldMixWeights` derives from it. It is stored so the mid-session
 * ⚖ panel can show back what the user actually typed: the fold spreads a category's share
 * across its groups' weights and cannot be inverted.
 */
export interface MixWeightConfig {
  category: { A: number; B: number };
  domain: { A: CombinedDomainWeights; B: CombinedDomainWeights };
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
  /** Mixed quiz only: the three-level inputs behind the folded weights above. Absent on every
   *  other variant, and on mixed sessions started before the setting existed. */
  mixWeights?: MixWeightConfig;
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
  /** ISO code — expressions are stored under ISO codes, unlike words/grammar. */
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
