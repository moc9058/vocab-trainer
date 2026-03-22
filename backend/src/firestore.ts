import { Firestore, FieldValue } from "@google-cloud/firestore";
import type {
  Word,
  VocabFile,
  LanguageInfo,
  WordIndexEntry,
  WordProgress,
  ProgressFile,
  QuizSession,
  PaginatedResult,
  Topic,
} from "./types.js";

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

// --- Collections ---
const languages = db.collection("languages");
const words = db.collection("words");
const idMaps = db.collection("id_maps");
const wordIndex = db.collection("word_index");
const progress = db.collection("progress");
const quizSessions = db.collection("quiz_sessions");

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

export async function getWords(
  language: string,
  filters?: { search?: string; topic?: string; category?: string; level?: string },
  pagination?: { page: number; limit: number }
): Promise<PaginatedResult<Word>> {
  // Build Firestore query with supported filters
  let query = words.where("language", "==", language) as FirebaseFirestore.Query;

  if (filters?.topic) {
    query = query.where("topics", "array-contains", filters.topic);
  }
  if (filters?.category) {
    query = query.where("grammaticalCategory", "==", filters.category);
  }
  if (filters?.level) {
    query = query.where("level", "==", filters.level);
  }

  const snap = await query.get();
  let results = snap.docs.map(docToWord);

  // Client-side text search (Firestore doesn't support full-text search)
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    results = results.filter(
      (w) =>
        w.term.toLowerCase().includes(q) ||
        w.transliteration?.toLowerCase().includes(q) ||
        Object.values(w.definition).some((d) => d.toLowerCase().includes(q))
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

  // Expand base levels to include their -extended variants
  const expandedLevels = filters?.levels?.flatMap((l) => [l, `${l}-extended`]);
  const f = filters ? { ...filters, levels: expandedLevels } : filters;

  const hasTopicFilter = f?.topics && f.topics.length > 0;
  const hasCategoryFilter = f?.categories && f.categories.length > 0;
  const hasLevelFilter = expandedLevels && expandedLevels.length > 0;

  if (hasTopicFilter || hasCategoryFilter || hasLevelFilter) {
    results = results.filter((w) => {
      // Level acts as a scope limiter (AND with other filters)
      const matchesLevel = !hasLevelFilter || (!!w.level && expandedLevels!.includes(w.level));
      // Topics and categories are additive (OR with each other)
      const matchesContent = !hasTopicFilter && !hasCategoryFilter
        ? true
        : (hasTopicFilter && w.topics.some((t) => f!.topics!.includes(t))) ||
          (hasCategoryFilter && f!.categories!.includes(w.grammaticalCategory));
      return matchesLevel && matchesContent;
    });
  }

  return results;
}

export async function getWordFilters(language: string): Promise<{
  topics: Topic[];
  categories: string[];
  levels: string[];
}> {
  const snap = await words.where("language", "==", language).get();
  const allWords = snap.docs.map(docToWord);
  const topics = [...new Set(allWords.flatMap((w) => w.topics))] as Topic[];
  const categories = [...new Set(allWords.map((w) => w.grammaticalCategory).filter(Boolean))].sort();
  const levels = [...new Set(allWords.map((w) => w.level?.replace(/-extended$/, "")).filter((l): l is string => !!l))].sort();
  return { topics, categories, levels };
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

export async function batchAddTransliterationEntries(
  language: string,
  entries: { term: string; transliteration: string }[]
): Promise<void> {
  const BATCH_LIMIT = 500;
  for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
    const chunk = entries.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const { term, transliteration } of chunk) {
      const docId = `${language}_${term}`;
      batch.set(wordIndex.doc(docId), {
        language,
        term,
        id: "",
        level: "",
        transliteration,
      });
    }
    await batch.commit();
  }
}

export async function updateWord(language: string, wordId: string, updates: Partial<Word>): Promise<Word | null> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return null;

  const oldData = doc.data()!;
  const data: Record<string, unknown> = { ...updates };
  delete data.id;
  await words.doc(wordId).update(data);

  const updated = await words.doc(wordId).get();
  if (updates.topics || updates.level) {
    await updateLanguageMeta(language);
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
  // Remove from word_index
  await wordIndex.doc(`${language}_${term}`).delete();
  return true;
}

export async function wordIdExists(wordId: string): Promise<boolean> {
  const doc = await words.doc(wordId).get();
  return doc.exists;
}

function docToWord(doc: FirebaseFirestore.DocumentSnapshot): Word {
  const d = doc.data()!;
  return {
    id: doc.id,
    term: d.term,
    transliteration: d.transliteration,
    definition: d.definition,
    grammaticalCategory: d.grammaticalCategory,
    examples: (d.examples ?? []).map((ex: any) => ({
      sentence: ex.sentence,
      translation: ex.translation,
      segments: ex.segments?.map((seg: any) => ({
        text: seg.text,
        transliteration: seg.transliteration ?? seg.pinyin,
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

// ========== Transliteration Map ==========

const transliterationCache = new Map<string, { map: Record<string, string>; ts: number }>();
const CACHE_TTL = 60_000; // 60s

export async function getTransliterationMap(language: string): Promise<Record<string, string>> {
  const cached = transliterationCache.get(language);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.map;
  }

  // 1. Build map from word_index (vocabulary terms)
  const snap = await wordIndex.where("language", "==", language).get();
  const map: Record<string, string> = {};
  for (const doc of snap.docs) {
    const d = doc.data();
    const transliteration = d.transliteration ?? d.pinyin;
    if (d.term && transliteration) {
      map[d.term] = transliteration;
    }
  }

  // 2. Harvest transliterations from precomputed example segments
  //    so the fallback covers non-vocabulary words in sentences
  const wordSnap = await words.where("language", "==", language).get();
  for (const doc of wordSnap.docs) {
    const d = doc.data();
    for (const ex of d.examples ?? []) {
      for (const seg of ex.segments ?? []) {
        const trans = seg.transliteration ?? seg.pinyin;
        if (seg.text && trans && !map[seg.text]) {
          map[seg.text] = trans;
        }
      }
    }
  }

  transliterationCache.set(language, { map, ts: Date.now() });
  return map;
}

export { db };
