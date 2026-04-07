import { Firestore, FieldValue, FieldPath } from "@google-cloud/firestore";
import type {
  Word,
  Meaning,
  VocabFile,
  LanguageInfo,
  WordIndexEntry,
  WordProgress,
  ProgressFile,
  QuizSession,
  PaginatedResult,
  Topic,
  GrammarComponent,
  GrammarProgress,
  GrammarQuizSession,
  TranslationEntry,
  TranslationResult,
  SpeakingWritingSession,
  TokenUsageRecord,
  TokenUsageDailySummary,
  TokenCostConfig,
} from "./types.js";

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const CACHE_TTL = 60_000; // 60s

// --- Collections ---
const languages = db.collection("languages");
const words = db.collection("words");
const idMaps = db.collection("id_maps");
const wordIndex = db.collection("word_index");
const progress = db.collection("progress");
const quizSessions = db.collection("quiz_sessions");
const flaggedWords = db.collection("flagged_words");

// ========== Languages ==========

export async function listLanguages(): Promise<LanguageInfo[]> {
  const snap = await languages.get();
  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      filename: `${doc.id}.json`,
      language: doc.id.charAt(0).toUpperCase() + doc.id.slice(1),
      topics: d.topics ?? [],
      levels: d.levels ?? [],
      wordCount: d.wordCount ?? 0,
    };
  });
}

export async function getLanguage(language: string): Promise<LanguageInfo | null> {
  const doc = await languages.doc(language).get();
  if (!doc.exists) return null;
  const d = doc.data()!;
  return {
    filename: `${language}.json`,
    language: language.charAt(0).toUpperCase() + language.slice(1),
    topics: d.topics ?? [],
    levels: d.levels ?? [],
    wordCount: d.wordCount ?? 0,
  };
}

export async function languageExists(language: string): Promise<boolean> {
  const doc = await languages.doc(language).get();
  return doc.exists;
}

export async function createLanguage(language: string): Promise<void> {
  await languages.doc(language).set({ wordCount: 0, topics: [] });
}

export async function deleteLanguage(language: string): Promise<boolean> {
  const doc = await languages.doc(language).get();
  if (!doc.exists) return false;
  await languages.doc(language).delete();
  return true;
}

async function updateLanguageMeta(language: string): Promise<void> {
  const snap = await words.where("language", "==", language).select("topics", "level").get();
  const topicSet = new Set<string>();
  const levelSet = new Set<string>();
  snap.docs.forEach((doc) => {
    const d = doc.data();
    const t = d.topics as string[];
    t?.forEach((topic) => topicSet.add(topic));
    if (d.level) levelSet.add(d.level as string);
  });
  await languages.doc(language).set(
    { wordCount: snap.size, topics: [...topicSet], levels: [...levelSet].sort() },
    { merge: true }
  );
}

// ========== Words ==========

// Search word_index (small docs) to find matching word IDs, then batch-fetch full words
async function searchWordIndex(language: string, searchTerm: string): Promise<string[]> {
  const snap = await wordIndex.where("language", "==", language).get();
  const q = searchTerm.toLowerCase();
  const matchingIds: string[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const term = (d.term as string || "").toLowerCase();
    const transliteration = ((d.transliteration ?? d.pinyin) as string || "").toLowerCase();
    if (term.includes(q) || transliteration.includes(q)) {
      matchingIds.push(d.id as string);
    }
  }
  return matchingIds;
}

function applyFilters(
  results: Word[],
  filters: { search?: string; topic?: string; category?: string; level?: string },
): Word[] {
  if (filters.topic) {
    const t = filters.topic;
    results = results.filter((w) => (w.topics as string[]).includes(t));
  }
  if (filters.category) {
    results = results.filter((w) => w.definitions.some((m) => m.partOfSpeech === filters.category));
  }
  if (filters.level) {
    results = results.filter((w) => w.level === filters.level);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    results = results.filter(
      (w) =>
        w.term.toLowerCase().includes(q) ||
        w.transliteration?.toLowerCase().includes(q) ||
        w.definitions.some((m) => Object.values(m.text).some((d) => d.toLowerCase().includes(q)))
    );
  }
  return results;
}

function paginateResults(results: Word[], page: number, limit: number): PaginatedResult<Word> {
  const total = results.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const start = (page - 1) * limit;
  const items = results.slice(start, start + limit);
  return { items, total, page, limit, totalPages };
}

export async function getWords(
  language: string,
  filters?: { search?: string; topic?: string; category?: string; level?: string; flaggedOnly?: boolean },
  pagination?: { page: number; limit: number }
): Promise<PaginatedResult<Word>> {
  const page = pagination?.page ?? 1;
  const limit = pagination?.limit ?? 50;

  // Flagged-only: fetch only flagged words by ID (avoids full collection scan)
  if (filters?.flaggedOnly) {
    const flagged = await getFlaggedWords(language);
    const flaggedWordIds = flagged.map((f) => f.wordId);
    let results = await getWordsByIds(flaggedWordIds);
    results = applyFilters(results, filters);
    return paginateResults(results, page, limit);
  }

  // Search: use word_index (small docs) to find matches, then batch-fetch full words
  if (filters?.search) {
    const matchingIds = await searchWordIndex(language, filters.search);
    let results = await getWordsByIds(matchingIds);
    results = applyFilters(results, { ...filters, search: undefined });
    return paginateResults(results, page, limit);
  }

  // Category filter requires client-side filtering (definitions is a nested array),
  // so when category is active we fetch all and paginate in-memory.
  let query = words.where("language", "==", language) as FirebaseFirestore.Query;
  if (filters?.topic) {
    query = query.where("topics", "array-contains", filters.topic);
  }
  if (filters?.level) {
    query = query.where("level", "==", filters.level);
  }

  if (filters?.category) {
    const snap = await query.get();
    let results = snap.docs.map(docToWord);
    results = applyFilters(results, filters);
    return paginateResults(results, page, limit);
  }

  // Server-side pagination when no category filter
  query = query.orderBy(FieldPath.documentId());
  const countSnap = await query.count().get();
  const total = countSnap.data().count;
  const totalPages = Math.ceil(total / limit) || 1;
  const offset = (page - 1) * limit;
  const snap = await query.offset(offset).limit(limit).get();
  const items = snap.docs.map(docToWord);

  return { items, total, page, limit, totalPages };
}

export async function getAllWords(language: string): Promise<Word[]> {
  const snap = await words.where("language", "==", language).get();
  return snap.docs.map(docToWord);
}

export async function getFilteredWords(
  language: string,
  filters?: { topics?: string[]; categories?: string[]; levels?: string[] }
): Promise<Word[]> {
  // Firestore array-contains can only filter on one topic at a time,
  // so we fetch all words and filter client-side for multi-value filters
  const snap = await words.where("language", "==", language).get();
  let results = snap.docs.map(docToWord);

  const hasTopicFilter = filters?.topics && filters.topics.length > 0;
  const hasCategoryFilter = filters?.categories && filters.categories.length > 0;
  const hasLevelFilter = filters?.levels && filters.levels.length > 0;

  if (hasTopicFilter || hasCategoryFilter || hasLevelFilter) {
    results = results.filter((w) => {
      // Level acts as a scope limiter (AND with other filters)
      const matchesLevel = !hasLevelFilter || (!!w.level && filters!.levels!.includes(w.level));
      // Topics and categories are additive (OR with each other)
      const matchesContent = !hasTopicFilter && !hasCategoryFilter
        ? true
        : (hasTopicFilter && w.topics.some((t) => filters!.topics!.includes(t))) ||
          (hasCategoryFilter && w.definitions.some((m) => filters!.categories!.includes(m.partOfSpeech)));
      return matchesLevel && matchesContent;
    });
  }

  return results;
}

const wordFiltersCache = new Map<string, { data: { topics: Topic[]; categories: string[]; levels: string[] }; ts: number }>();

export function invalidateWordFiltersCache(language: string): void {
  wordFiltersCache.delete(language);
}

export async function getWordFilters(language: string): Promise<{
  topics: Topic[];
  categories: string[];
  levels: string[];
}> {
  const cached = wordFiltersCache.get(language);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  const snap = await words.where("language", "==", language).get();
  const allWords = snap.docs.map(docToWord);
  const topics = [...new Set(allWords.flatMap((w) => w.topics))] as Topic[];
  const categories = [...new Set(allWords.flatMap((w) => w.definitions.map((m) => m.partOfSpeech)).filter(Boolean))].sort();
  const levels = [...new Set(allWords.map((w) => w.level).filter((l): l is string => !!l))].sort();
  const data = { topics, categories, levels };
  wordFiltersCache.set(language, { data, ts: Date.now() });
  return data;
}

export async function getWord(wordId: string): Promise<Word | null> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return null;
  return docToWord(doc);
}

export async function getWordsByIds(wordIds: string[]): Promise<Word[]> {
  if (wordIds.length === 0) return [];
  const refs = wordIds.map((id) => words.doc(id));
  const docs = await db.getAll(...refs);
  return docs.filter((d) => d.exists).map(docToWord);
}

export async function addWord(language: string, word: Word): Promise<void> {
  const data: Record<string, unknown> = { ...word, language };
  delete data.id;
  await words.doc(word.id).set(data);
  await updateLanguageMeta(language);
  invalidateWordFiltersCache(language);

  // Write to word_index
  const indexDocId = `${language}_${word.term}`;
  await wordIndex.doc(indexDocId).set({
    language,
    term: word.term,
    id: word.id,
    level: word.level ?? "",
    transliteration: word.transliteration ?? "",
  });
}

export async function updateWord(language: string, wordId: string, updates: Partial<Word>): Promise<Word | null> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return null;

  const oldData = doc.data()!;
  const data: Record<string, unknown> = { ...updates };
  delete data.id;

  // Preserve per-example segments when the sentence text is unchanged.
  // WordFormModal does not carry segments through its form state, so without
  // this merge every word edit would wipe the LLM-generated pinyin segments.
  if (Array.isArray(updates.examples) && Array.isArray(oldData.examples)) {
    const oldBySentence = new Map<string, unknown>();
    for (const oldEx of oldData.examples as { sentence: string; segments?: unknown }[]) {
      if (oldEx?.segments) oldBySentence.set(oldEx.sentence, oldEx.segments);
    }
    data.examples = (updates.examples as { sentence: string; segments?: unknown }[]).map((ex) => {
      if (ex.segments) return ex;
      const oldSegs = oldBySentence.get(ex.sentence);
      return oldSegs ? { ...ex, segments: oldSegs } : ex;
    });
  }

  await words.doc(wordId).update(data);

  const updated = await words.doc(wordId).get();
  if (updates.topics || updates.level || updates.definitions) {
    await updateLanguageMeta(language);
    invalidateWordFiltersCache(language);

  }

  // Sync word_index on term/level/pinyin change
  if (updates.term || updates.level !== undefined || updates.transliteration !== undefined) {
    const oldTerm = oldData.term as string;
    const newTerm = updates.term ?? oldTerm;

    // If term changed, delete old index entry
    if (updates.term && updates.term !== oldTerm) {
      await wordIndex.doc(`${language}_${oldTerm}`).delete();
    }

    const updatedWord = docToWord(updated);
    await wordIndex.doc(`${language}_${newTerm}`).set({
      language,
      term: newTerm,
      id: wordId,
      level: updatedWord.level ?? "",
      transliteration: updatedWord.transliteration ?? "",
    });
  }

  return docToWord(updated);
}

export async function deleteWord(language: string, wordId: string): Promise<boolean> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return false;
  const term = doc.data()!.term as string;
  await words.doc(wordId).delete();
  await updateLanguageMeta(language);
  invalidateWordFiltersCache(language);

  // Remove from word_index
  await wordIndex.doc(`${language}_${term}`).delete();
  return true;
}

export async function wordIdExists(wordId: string): Promise<boolean> {
  const doc = await words.doc(wordId).get();
  return doc.exists;
}

/** Normalize old format (definition + grammaticalCategory) to new (definitions: Meaning[]) */
function normalizeDefinitions(d: Record<string, unknown>): Meaning[] {
  if (Array.isArray(d.definitions)) return d.definitions as Meaning[];
  // Backward compat: old format had definition: Record<string, string> + grammaticalCategory: string
  if (d.definition && typeof d.definition === "object") {
    return [{ partOfSpeech: (d.grammaticalCategory as string) || "", text: d.definition as Record<string, string> }];
  }
  return [];
}

function docToWord(doc: FirebaseFirestore.DocumentSnapshot): Word {
  const d = doc.data()!;
  return {
    id: doc.id,
    term: d.term,
    transliteration: d.transliteration,
    definitions: normalizeDefinitions(d),
    examples: (d.examples ?? []).map((ex: any) => ({
      sentence: ex.sentence,
      translation: ex.translation,
      segments: ex.segments?.map((seg: any) => ({
        text: seg.text,
        transliteration: seg.transliteration ?? seg.pinyin,
        ...(seg.id ? { id: seg.id } : {}),
      })),
    })),
    topics: d.topics ?? [],
    level: d.level,
    notes: d.notes,
  };
}

// ========== ID Maps ==========

export async function getNextWordId(language: string): Promise<string> {
  const isoMap: Record<string, string> = {
    chinese: "zh", english: "en", french: "fr", german: "de",
    italian: "it", japanese: "ja", korean: "ko", portuguese: "pt",
    russian: "ru", spanish: "es",
  };

  const docRef = idMaps.doc(language);
  const doc = await docRef.get();

  let nextId: number;
  let prefix: string;

  if (doc.exists) {
    const data = doc.data()!;
    nextId = data.next_id;
    prefix = isoMap[language.toLowerCase()] ?? language.slice(0, 2).toLowerCase();
    await docRef.update({ next_id: FieldValue.increment(1) });
  } else {
    prefix = isoMap[language.toLowerCase()] ?? language.slice(0, 2).toLowerCase();
    nextId = 1;
    await docRef.set({ next_id: 2 });
  }

  return `${prefix}-${String(nextId).padStart(6, "0")}`;
}

// ========== Word Index ==========

export async function lookupWordByTerm(language: string, term: string): Promise<WordIndexEntry | null> {
  const docId = `${language}_${term}`;
  const doc = await wordIndex.doc(docId).get();
  if (!doc.exists) return null;
  const d = doc.data()!;
  return { term: d.term, id: d.id, level: d.level, transliteration: d.transliteration ?? d.pinyin };
}

export async function lookupWordsByTerms(language: string, terms: string[]): Promise<WordIndexEntry[]> {
  const results: WordIndexEntry[] = [];
  const CHUNK_SIZE = 100;

  for (let i = 0; i < terms.length; i += CHUNK_SIZE) {
    const chunk = terms.slice(i, i + CHUNK_SIZE);
    const refs = chunk.map((t) => wordIndex.doc(`${language}_${t}`));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      if (doc.exists) {
        const d = doc.data()!;
        results.push({ term: d.term, id: d.id, level: d.level, transliteration: d.transliteration ?? d.pinyin });
      }
    }
  }

  return results;
}

// ========== Progress ==========

export async function getProgressForLanguage(language: string): Promise<ProgressFile> {
  const snap = await progress.where("language", "==", language).get();
  const wordsMap: Record<string, WordProgress> = {};
  snap.docs.forEach((doc) => {
    const d = doc.data();
    wordsMap[d.wordId] = {
      timesSeen: d.timesSeen,
      timesCorrect: d.timesCorrect,
      correctRate: d.correctRate,
      lastReviewed: d.lastReviewed,
      streak: d.streak,
    };
  });
  return { language, words: wordsMap };
}

export async function getWordProgress(language: string, wordId: string): Promise<WordProgress> {
  const docId = `${language}_${wordId}`;
  const doc = await progress.doc(docId).get();
  if (!doc.exists) {
    return { timesSeen: 0, timesCorrect: 0, correctRate: 0, lastReviewed: "", streak: 0 };
  }
  const d = doc.data()!;
  return {
    timesSeen: d.timesSeen,
    timesCorrect: d.timesCorrect,
    correctRate: d.correctRate,
    lastReviewed: d.lastReviewed,
    streak: d.streak,
  };
}

export async function updateWordProgress(
  language: string,
  wordId: string,
  wp: WordProgress
): Promise<void> {
  const docId = `${language}_${wordId}`;
  await progress.doc(docId).set({
    language,
    wordId,
    ...wp,
  });
}

export async function deleteProgressForLanguage(language: string): Promise<void> {
  const snap = await progress.where("language", "==", language).get();
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

// ========== Quiz Sessions (keyed by language — one session per language) ==========

export async function getQuizSession(sessionId: string): Promise<QuizSession | null> {
  const doc = await quizSessions.doc(sessionId).get();
  if (!doc.exists) return null;
  return docToSession(doc);
}

export async function getQuizSessionByLanguage(language: string): Promise<QuizSession | null> {
  const doc = await quizSessions.doc(language).get();
  if (!doc.exists) return null;
  return docToSession(doc);
}

/** Strip heavy word data — only persist wordId, term, and answer state. */
function slimQuestions(questions: QuizSession["questions"]) {
  return questions.map((q) => ({
    wordId: q.wordId,
    term: q.term,
    ...(q.userCorrect !== undefined ? { userCorrect: q.userCorrect } : {}),
  }));
}

export async function createQuizSession(session: QuizSession): Promise<void> {
  const data: Record<string, unknown> = {
    ...session,
    questions: slimQuestions(session.questions),
  };
  delete data.sessionId;
  const clean = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined));
  await quizSessions.doc(session.language).set(clean);
}

export async function updateQuizSession(session: QuizSession): Promise<void> {
  const data: Record<string, unknown> = {
    ...session,
    questions: slimQuestions(session.questions),
  };
  delete data.sessionId;
  const clean = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined));
  await quizSessions.doc(session.language).set(clean);
}

function docToSession(doc: FirebaseFirestore.DocumentSnapshot): QuizSession {
  const d = doc.data()!;
  return {
    sessionId: doc.id,
    language: d.language,
    startedAt: d.startedAt,
    completedAt: d.completedAt,
    status: d.status,
    score: d.score,
    questions: d.questions,
    questionType: d.questionType,
    wordIds: d.wordIds,
  };
}

// ========== Flagged Words ==========

export async function getFlaggedWords(language: string): Promise<{ wordId: string; flaggedAt: string }[]> {
  const snap = await flaggedWords.where("language", "==", language).get();
  return snap.docs.map((doc) => {
    const d = doc.data();
    return { wordId: d.wordId, flaggedAt: d.flaggedAt };
  });
}

export async function getFlaggedWordCount(language: string): Promise<number> {
  const snap = await flaggedWords.where("language", "==", language).get();
  return snap.size;
}

export async function flagWord(language: string, wordId: string): Promise<void> {
  const docId = `${language}_${wordId}`;
  await flaggedWords.doc(docId).set({
    language,
    wordId,
    flaggedAt: new Date().toISOString(),
  });
}

export async function unflagWord(language: string, wordId: string): Promise<boolean> {
  const docId = `${language}_${wordId}`;
  const doc = await flaggedWords.doc(docId).get();
  if (!doc.exists) return false;
  await flaggedWords.doc(docId).delete();
  return true;
}

// ========== Grammar ==========

const grammarChapters = db.collection("grammar_chapters");
const grammarItems = db.collection("grammar_items");
const grammarProgress = db.collection("grammar_progress");
const grammarQuizSessions = db.collection("grammar_quiz_sessions");

export async function listGrammarChapters(language: string): Promise<
  { chapterNumber: number; chapterTitle: Record<string, string>; subchapterCount: number }[]
> {
  const snap = await grammarChapters.where("language", "==", language).get();
  return snap.docs
    .map((doc) => {
      const d = doc.data();
      return {
        chapterNumber: d.chapterNumber as number,
        chapterTitle: d.chapterTitle as Record<string, string>,
        subchapterCount: d.subchapterCount as number,
      };
    })
    .sort((a, b) => a.chapterNumber - b.chapterNumber);
}

export async function getChapterSubchapters(
  language: string,
  chapterNumbers?: number[]
): Promise<{ chapterNumber: number; subchapterId: string; subchapterTitle: Record<string, string> }[]> {
  let query = grammarChapters.where("language", "==", language) as FirebaseFirestore.Query;
  const snap = await query.get();
  const result: { chapterNumber: number; subchapterId: string; subchapterTitle: Record<string, string> }[] = [];

  for (const doc of snap.docs) {
    const d = doc.data();
    const chNum = d.chapterNumber as number;
    if (chapterNumbers && chapterNumbers.length > 0 && !chapterNumbers.includes(chNum)) continue;
    const subs = d.subchapters as { id: string; title: Record<string, string> }[] | undefined;
    if (subs) {
      for (const s of subs) {
        result.push({ chapterNumber: chNum, subchapterId: s.id, subchapterTitle: s.title });
      }
    }
  }

  return result;
}

export interface GrammarItemDoc extends GrammarComponent {
  language: string;
  chapterNumber: number;
  subchapterId: string;
  subchapterTitle: Record<string, string>;
}

export async function getGrammarItems(
  language: string,
  filters?: { chapter?: number; subchapter?: string; level?: string; search?: string },
  pagination?: { page: number; limit: number }
): Promise<PaginatedResult<GrammarItemDoc>> {
  let query = grammarItems.where("language", "==", language) as FirebaseFirestore.Query;

  if (filters?.chapter) {
    query = query.where("chapterNumber", "==", filters.chapter);
  }
  if (filters?.subchapter) {
    query = query.where("subchapterId", "==", filters.subchapter);
  }
  if (filters?.level) {
    query = query.where("level", "==", filters.level);
  }

  const snap = await query.get();
  let results = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as GrammarItemDoc));

  if (filters?.search) {
    const q = filters.search.toLowerCase();
    results = results.filter(
      (item) =>
        Object.values(item.term).some((t) => (t as string).toLowerCase().includes(q)) ||
        Object.values(item.description ?? {}).some((d) => (d as string).toLowerCase().includes(q)) ||
        item.words?.some((w: string) => w.toLowerCase().includes(q))
    );
  }

  const page = pagination?.page ?? 1;
  const limit = pagination?.limit ?? 50;
  const total = results.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const start = (page - 1) * limit;
  const items = results.slice(start, start + limit);

  return { items, total, page, limit, totalPages };
}

export async function getAllGrammarItems(language: string): Promise<GrammarItemDoc[]> {
  const snap = await grammarItems.where("language", "==", language).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as GrammarItemDoc));
}

export async function getGrammarItem(componentId: string): Promise<GrammarItemDoc | null> {
  const doc = await grammarItems.doc(componentId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as GrammarItemDoc;
}

export async function upsertGrammarItem(item: GrammarItemDoc): Promise<void> {
  const data: Record<string, unknown> = { ...item };
  delete data.id;
  await grammarItems.doc(item.id).set(data);
}

export async function deleteGrammarItem(componentId: string): Promise<boolean> {
  const doc = await grammarItems.doc(componentId).get();
  if (!doc.exists) return false;
  await grammarItems.doc(componentId).delete();
  return true;
}

export async function upsertGrammarChapter(
  language: string,
  chapterNumber: number,
  chapterTitle: Record<string, string>,
  subchapterCount: number
): Promise<void> {
  const docId = `${language}_${chapterNumber}`;
  await grammarChapters.doc(docId).set({ language, chapterNumber, chapterTitle, subchapterCount });
}

// ========== Grammar Progress ==========

export async function getGrammarProgressForLanguage(
  language: string
): Promise<Record<string, GrammarProgress>> {
  const snap = await grammarProgress.where("language", "==", language).get();
  const result: Record<string, GrammarProgress> = {};
  snap.docs.forEach((doc) => {
    const d = doc.data();
    result[d.componentId] = {
      timesSeen: d.timesSeen,
      timesCorrect: d.timesCorrect,
      correctRate: d.correctRate,
      lastReviewed: d.lastReviewed,
      streak: d.streak,
    };
  });
  return result;
}

export async function getGrammarComponentProgress(
  language: string,
  componentId: string
): Promise<GrammarProgress> {
  const docId = `${language}_${componentId}`;
  const doc = await grammarProgress.doc(docId).get();
  if (!doc.exists) {
    return { timesSeen: 0, timesCorrect: 0, correctRate: 0, lastReviewed: "", streak: 0 };
  }
  const d = doc.data()!;
  return {
    timesSeen: d.timesSeen,
    timesCorrect: d.timesCorrect,
    correctRate: d.correctRate,
    lastReviewed: d.lastReviewed,
    streak: d.streak,
  };
}

export async function updateGrammarComponentProgress(
  language: string,
  componentId: string,
  gp: GrammarProgress
): Promise<void> {
  const docId = `${language}_${componentId}`;
  await grammarProgress.doc(docId).set({ language, componentId, ...gp });
}

export async function deleteGrammarProgressForLanguage(language: string): Promise<void> {
  const snap = await grammarProgress.where("language", "==", language).get();
  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

// ========== Grammar Quiz Sessions ==========

export async function getGrammarQuizSession(language: string): Promise<GrammarQuizSession | null> {
  const doc = await grammarQuizSessions.doc(language).get();
  if (!doc.exists) return null;
  const d = doc.data()!;
  return {
    sessionId: doc.id,
    language: d.language,
    startedAt: d.startedAt,
    completedAt: d.completedAt,
    status: d.status,
    score: d.score,
    questions: d.questions,
    chapterFilter: d.chapterFilter,
  };
}

export async function saveGrammarQuizSession(session: GrammarQuizSession): Promise<void> {
  const data: Record<string, unknown> = { ...session };
  delete data.sessionId;
  const clean = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined));
  await grammarQuizSessions.doc(session.language).set(clean);
}

// ========== Translation History ==========

const translationHistory = db.collection("translation_history");

export async function saveTranslationEntry(
  entry: Omit<TranslationEntry, "id">
): Promise<TranslationEntry> {
  const docRef = translationHistory.doc();
  await docRef.set(entry);
  return { id: docRef.id, ...entry };
}

export async function getTranslationHistory(
  page = 1,
  limit = 20
): Promise<{ entries: TranslationEntry[]; total: number }> {
  const countSnap = await translationHistory.count().get();
  const total = countSnap.data().count;
  const offset = (page - 1) * limit;
  const snap = await translationHistory
    .orderBy("createdAt", "desc")
    .offset(offset)
    .limit(limit)
    .get();
  const entries = snap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as TranslationEntry[];
  return { entries, total };
}

export async function deleteTranslationEntry(id: string): Promise<boolean> {
  const doc = await translationHistory.doc(id).get();
  if (!doc.exists) return false;
  await translationHistory.doc(id).delete();
  return true;
}

export async function clearTranslationHistory(): Promise<void> {
  const snap = await translationHistory.get();
  const BATCH_LIMIT = 500;
  for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    snap.docs.slice(i, i + BATCH_LIMIT).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

// ========== Speaking & Writing Sessions ==========

const speakingWritingSessions = db.collection("speaking_writing_sessions");

export async function getSpeakingWritingSession(
  language: string
): Promise<SpeakingWritingSession | null> {
  const doc = await speakingWritingSessions.doc(language).get();
  if (!doc.exists) return null;
  const d = doc.data()!;
  return {
    sessionId: doc.id,
    language: d.language,
    mode: d.mode,
    useCase: d.useCase ?? "",
    startedAt: d.startedAt,
    status: d.status,
    corrections: d.corrections ?? [],
    currentIndex: d.currentIndex ?? 0,
  };
}

export async function saveSpeakingWritingSession(
  session: SpeakingWritingSession
): Promise<void> {
  const { sessionId, ...data } = session;
  await speakingWritingSessions.doc(session.language).set(data);
}

export async function deleteSpeakingWritingSession(
  language: string
): Promise<boolean> {
  const doc = await speakingWritingSessions.doc(language).get();
  if (!doc.exists) return false;
  await speakingWritingSessions.doc(language).delete();
  return true;
}

// ========== Token Usage Metrics ==========

const tokenUsage = db.collection("token_usage");
const tokenUsageDaily = db.collection("token_usage_daily");

export async function logTokenUsage(
  record: Omit<TokenUsageRecord, "id">
): Promise<void> {
  // Write individual record
  await tokenUsage.doc().set(record);

  // Increment daily aggregate
  const date = record.timestamp.slice(0, 10); // YYYY-MM-DD
  const dailyDocId = `${record.model}_${date}`;
  const dailyRef = tokenUsageDaily.doc(dailyDocId);

  await dailyRef.set(
    {
      model: record.model,
      date,
      totalCalls: FieldValue.increment(1),
      promptTokens: FieldValue.increment(record.promptTokens),
      completionTokens: FieldValue.increment(record.completionTokens),
      totalTokens: FieldValue.increment(record.totalTokens),
      cachedTokens: FieldValue.increment(record.cachedTokens ?? 0),
      thoughtsTokens: FieldValue.increment(record.thoughtsTokens ?? 0),
      [`byRoute.${record.route}.calls`]: FieldValue.increment(1),
      [`byRoute.${record.route}.promptTokens`]: FieldValue.increment(record.promptTokens),
      [`byRoute.${record.route}.completionTokens`]: FieldValue.increment(record.completionTokens),
      [`byRoute.${record.route}.totalTokens`]: FieldValue.increment(record.totalTokens),
    },
    { merge: true }
  );
}

export async function getTokenUsageLogs(filters?: {
  model?: string;
  route?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}): Promise<{ records: TokenUsageRecord[]; total: number }> {
  let query = tokenUsage.orderBy("timestamp", "desc") as FirebaseFirestore.Query;

  if (filters?.model) {
    query = query.where("model", "==", filters.model);
  }
  if (filters?.route) {
    query = query.where("route", "==", filters.route);
  }
  if (filters?.from) {
    query = query.where("timestamp", ">=", filters.from);
  }
  if (filters?.to) {
    query = query.where("timestamp", "<=", filters.to);
  }

  const countSnap = await query.count().get();
  const total = countSnap.data().count;

  const page = filters?.page ?? 1;
  const limit = filters?.limit ?? 50;
  const offset = (page - 1) * limit;

  const snap = await query.offset(offset).limit(limit).get();
  const records = snap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as TokenUsageRecord[];

  return { records, total };
}

export async function getDailyUsageSummaries(
  from?: string,
  to?: string
): Promise<TokenUsageDailySummary[]> {
  let query = tokenUsageDaily.orderBy("date", "desc") as FirebaseFirestore.Query;

  if (from) {
    query = query.where("date", ">=", from);
  }
  if (to) {
    query = query.where("date", "<=", to);
  }

  const snap = await query.get();
  return snap.docs.map((doc) => ({
    ...doc.data(),
  })) as TokenUsageDailySummary[];
}

const knownModels = new Set<string>();

export async function ensureModelInCostConfig(model: string): Promise<void> {
  if (knownModels.has(model)) return;
  const docRef = db.collection("config").doc("token_costs");
  const doc = await docRef.get();
  if (doc.exists) {
    const data = doc.data() as TokenCostConfig;
    if (data.models?.[model]) {
      knownModels.add(model);
      return;
    }
  }
  // Add model with zero rates
  await docRef.set(
    {
      models: {
        [model]: {
          input: 0,
          cachedInput: 0,
          output: 0,
          thoughtsInput: 0,
        },
      },
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
  knownModels.add(model);
}

export async function getTokenCostConfig(): Promise<TokenCostConfig | null> {
  const doc = await db.collection("config").doc("token_costs").get();
  if (!doc.exists) return null;
  return doc.data() as TokenCostConfig;
}

export async function setTokenCostConfig(config: TokenCostConfig): Promise<void> {
  await db.collection("config").doc("token_costs").set(config);
}

export async function clearTokenUsage(): Promise<void> {
  const BATCH_LIMIT = 500;

  // Clear individual records
  const usageSnap = await tokenUsage.get();
  for (let i = 0; i < usageSnap.docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    usageSnap.docs.slice(i, i + BATCH_LIMIT).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }

  // Clear daily summaries
  const dailySnap = await tokenUsageDaily.get();
  for (let i = 0; i < dailySnap.docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    dailySnap.docs.slice(i, i + BATCH_LIMIT).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
}

// ========== Config: Speaking & Writing ==========

export async function getSpeakingWritingConfig(): Promise<{
  outputSchema: Record<string, unknown>;
  prompts: Record<string, string>;
  useCases: Record<string, Record<string, Record<string, string>>>;
}> {
  const doc = await db.collection("config").doc("speaking_writing").get();
  if (!doc.exists) throw new Error("Missing config/speaking_writing in Firestore");
  const d = doc.data()!;
  return {
    outputSchema: d.outputSchema,
    prompts: d.prompts,
    useCases: d.useCases,
  };
}

// ========== Config: Translation ==========

export async function getTranslationConfig(): Promise<{
  decomposeSchema: Record<string, unknown>;
  decomposePrompts: Record<string, string>;
  translateSchema: Record<string, unknown>;
  translatePrompts: Record<string, string>;
}> {
  const doc = await db.collection("config").doc("translation").get();
  if (!doc.exists) throw new Error("Missing config/translation in Firestore");
  const d = doc.data()!;
  return {
    decomposeSchema: d.decomposeSchema,
    decomposePrompts: d.decomposePrompts,
    translateSchema: d.translateSchema,
    translatePrompts: d.translatePrompts,
  };
}

// ========== Config: Vocabulary ==========

export async function getVocabularyConfig(): Promise<{
  smartAddSchema: Record<string, unknown>;
  smartAddPrompts: Record<string, string>;
  segmentSchema: Record<string, unknown>;
  segmentPrompt: string;
}> {
  const doc = await db.collection("config").doc("vocabulary").get();
  if (!doc.exists) throw new Error("Missing config/vocabulary in Firestore");
  const d = doc.data()!;
  return {
    smartAddSchema: d.smartAddSchema,
    smartAddPrompts: d.smartAddPrompts,
    segmentSchema: d.segmentSchema,
    segmentPrompt: d.segmentPrompt,
  };
}

export { db };
