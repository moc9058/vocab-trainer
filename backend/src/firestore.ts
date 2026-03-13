import { Firestore, FieldValue } from "@google-cloud/firestore";
import type {
  Word,
  VocabFile,
  LanguageInfo,
  WordProgress,
  ProgressFile,
  QuizSession,
  PaginatedResult,
  Topic,
} from "./types.js";

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

// --- Collections ---
const languages = db.collection("languages");
const words = db.collection("words");
const idMaps = db.collection("id_maps");
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
  const snap = await words.where("language", "==", language).select("topics").get();
  const topicSet = new Set<string>();
  snap.docs.forEach((doc) => {
    const t = doc.data().topics as string[];
    t?.forEach((topic) => topicSet.add(topic));
  });
  await languages.doc(language).set(
    { wordCount: snap.size, topics: [...topicSet] },
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

  const hasTopicFilter = filters?.topics && filters.topics.length > 0;
  const hasCategoryFilter = filters?.categories && filters.categories.length > 0;
  const hasLevelFilter = filters?.levels && filters.levels.length > 0;

  if (hasTopicFilter || hasCategoryFilter || hasLevelFilter) {
    results = results.filter((w) => {
      const matchesTopic = hasTopicFilter && w.topics.some((t) => filters.topics!.includes(t));
      const matchesCategory = hasCategoryFilter && filters.categories!.includes(w.grammaticalCategory);
      const matchesLevel = hasLevelFilter && !!w.level && filters.levels!.includes(w.level);
      return matchesTopic || matchesCategory || matchesLevel;
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
  const levels = [...new Set(allWords.map((w) => w.level).filter((l): l is string => !!l))];
  return { topics, categories, levels };
}

export async function getWord(wordId: string): Promise<Word | null> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return null;
  return docToWord(doc);
}

export async function addWord(language: string, word: Word): Promise<void> {
  const data: Record<string, unknown> = { ...word, language };
  delete data.id;
  await words.doc(word.id).set(data);
  await updateLanguageMeta(language);
  // Update ID map
  await updateIdMap(language, word.term, word.id);
}

export async function updateWord(language: string, wordId: string, updates: Partial<Word>): Promise<Word | null> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return null;

  const data: Record<string, unknown> = { ...updates };
  delete data.id;
  await words.doc(wordId).update(data);

  const updated = await words.doc(wordId).get();
  if (updates.topics) {
    await updateLanguageMeta(language);
  }
  return docToWord(updated);
}

export async function deleteWord(language: string, wordId: string): Promise<boolean> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return false;
  await words.doc(wordId).delete();
  await updateLanguageMeta(language);
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
    examples: d.examples ?? [],
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
    await docRef.set({ next_id: 2, terms: {} });
  }

  return `${prefix}-${String(nextId).padStart(6, "0")}`;
}

async function updateIdMap(language: string, term: string, wordId: string): Promise<void> {
  const docRef = idMaps.doc(language);
  await docRef.set({ terms: { [term]: wordId } }, { merge: true });
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

export async function createQuizSession(session: QuizSession): Promise<void> {
  const data: Record<string, unknown> = { ...session };
  delete data.sessionId;
  const clean = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined));
  await quizSessions.doc(session.language).set(clean);
}

export async function updateQuizSession(session: QuizSession): Promise<void> {
  const data: Record<string, unknown> = { ...session };
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

export { db };
