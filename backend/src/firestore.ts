import { Firestore, FieldValue, FieldPath } from "@google-cloud/firestore";
import { createHash } from "crypto";
import type {
  Word,
  ExampleSentence,
  Example,
  Meaning,
  VocabFile,
  LanguageInfo,
  WordIndexEntry,
  WordProgress,
  ProgressFile,
  QuizSession,
  PaginatedResult,
  Topic,
  Grammar,
  GrammarDraft,
  WordDraft,
  GrammarGroup,
  GrammarProgress,
  GrammarQuizSession,
  CombinedQuizSession,
  TranslationEntry,
  TranslationResult,
  SpeakingWritingSession,
  TokenUsageRecord,
  TokenUsageDailySummary,
  TokenCostConfig,
  GrammarSettings,
  WordGroup,
  GroupCategory,
  Expression,
  ExpressionGroup,
  ImportSession,
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
const exampleSentences = db.collection("example_sentences");
const exampleSentenceIndex = db.collection("example_sentence_index");
const wordGroups = db.collection("word_groups");

/** Internal type: Word with optional Firestore-stored ID arrays (pre-hydration). */
interface WordRaw extends Word {
  exampleIds?: string[];
  appearsInIds?: string[];
}

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
    if (term.includes(q)) {
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
    results = results.filter((w) => w.term.toLowerCase().includes(q));
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
  filters?: { search?: string; topic?: string; category?: string; level?: string; flaggedOnly?: boolean; groupId?: string },
  pagination?: { page: number; limit: number }
): Promise<PaginatedResult<Word>> {
  const page = pagination?.page ?? 1;
  const limit = pagination?.limit ?? 50;

  // Group filter: fetch group's wordIds then apply all other filters in-memory
  if (filters?.groupId) {
    const group = await getWordGroup(filters.groupId);
    const groupWordIds = group?.wordIds ?? [];
    let results = await getWordsByIds(groupWordIds);
    if (filters.flaggedOnly) {
      const flagged = await getFlaggedWords(language);
      const flaggedWordIds = new Set(flagged.map((f) => f.wordId));
      results = results.filter((w) => flaggedWordIds.has(w.id));
    }
    const { groupId: _g, flaggedOnly: _f, ...rest } = filters;
    results = applyFilters(results, rest);
    return paginateResults(results, page, limit);
  }

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
    let results = await hydrateWords(snap.docs.map(docToWord));
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
  const items = await hydrateWords(snap.docs.map(docToWord));

  return { items, total, page, limit, totalPages };
}

export async function getAllWords(language: string): Promise<Word[]> {
  const snap = await words.where("language", "==", language).get();
  return hydrateWords(snap.docs.map(docToWord));
}

export async function getFilteredWords(
  language: string,
  filters?: { topics?: string[]; categories?: string[]; levels?: string[]; groupIds?: string[]; flaggedOnly?: boolean }
): Promise<Word[]> {
  // Firestore array-contains can only filter on one topic at a time,
  // so we fetch all words and filter client-side for multi-value filters
  const snap = await words.where("language", "==", language).get();
  let results = await hydrateWords(snap.docs.map(docToWord));

  const hasTopicFilter = filters?.topics && filters.topics.length > 0;
  const hasCategoryFilter = filters?.categories && filters.categories.length > 0;
  const hasLevelFilter = filters?.levels && filters.levels.length > 0;
  const hasGroupFilter = filters?.groupIds && filters.groupIds.length > 0;
  const hasFlaggedFilter = !!filters?.flaggedOnly;

  // Group filter: resolve all selected groups and compute union of their wordIds
  let groupWordIdSet: Set<string> | null = null;
  if (hasGroupFilter) {
    const groupDocs = await Promise.all(filters!.groupIds!.map((id) => getWordGroup(id)));
    const union = new Set<string>();
    for (const g of groupDocs) {
      if (g) for (const wid of g.wordIds) union.add(wid);
    }
    groupWordIdSet = union;
  }

  // Flagged filter: restrict the pool to flagged words (AND with the other filters)
  let flaggedWordIdSet: Set<string> | null = null;
  if (hasFlaggedFilter) {
    const flagged = await getFlaggedWords(language);
    flaggedWordIdSet = new Set(flagged.map((f) => f.wordId));
  }

  if (hasTopicFilter || hasCategoryFilter || hasLevelFilter || hasGroupFilter || hasFlaggedFilter) {
    results = results.filter((w) => {
      // Group acts as a scope limiter (AND with other filters)
      const matchesGroup = !groupWordIdSet || groupWordIdSet.has(w.id);
      // Flagged acts as a scope limiter (AND with other filters)
      const matchesFlagged = !flaggedWordIdSet || flaggedWordIdSet.has(w.id);
      // Level acts as a scope limiter (AND with other filters)
      const matchesLevel = !hasLevelFilter || (!!w.level && filters!.levels!.includes(w.level));
      // Topics and categories are additive (OR with each other)
      const matchesContent = !hasTopicFilter && !hasCategoryFilter
        ? true
        : (hasTopicFilter && w.topics.some((t) => filters!.topics!.includes(t))) ||
          (hasCategoryFilter && w.definitions.some((m) => filters!.categories!.includes(m.partOfSpeech)));
      return matchesGroup && matchesFlagged && matchesLevel && matchesContent;
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
  const raw = docToWord(doc);
  const [hydrated] = await hydrateWords([raw]);
  return hydrated;
}

export async function getWordsByIds(wordIds: string[]): Promise<Word[]> {
  if (wordIds.length === 0) return [];
  const refs = wordIds.map((id) => words.doc(id));
  const docs = await db.getAll(...refs);
  const rawWords = docs.filter((d) => d.exists).map(docToWord);
  return hydrateWords(rawWords);
}

export async function addWord(
  language: string,
  word: Word,
  opts?: { exampleIds?: string[]; appearsInIds?: string[] },
): Promise<void> {
  const data: Record<string, unknown> = { ...word, language };
  delete data.id;

  if (opts?.exampleIds) {
    // New format: store IDs instead of embedded examples
    delete data.examples;
    data.exampleIds = opts.exampleIds;
    // Invariant: appearsInIds ⊇ exampleIds. Callers don't need to include
    // own exampleIds in opts.appearsInIds — the union is enforced here.
    const appearsSet = new Set<string>(opts.appearsInIds ?? []);
    for (const exId of opts.exampleIds) appearsSet.add(exId);
    data.appearsInIds = [...appearsSet];
  }

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

export async function updateWord(
  language: string,
  wordId: string,
  updates: Partial<Word>,
  opts?: { exampleIds?: string[]; appearsInIds?: string[] },
): Promise<Word | null> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return null;

  const oldData = doc.data()!;
  const isNewFormat = Array.isArray(oldData.exampleIds);
  const data: Record<string, unknown> = { ...updates };
  delete data.id;

  if (isNewFormat) {
    // New format: don't store embedded examples on the word doc
    delete data.examples;
    if (opts?.exampleIds) {
      data.exampleIds = opts.exampleIds;
      // Invariant: appearsInIds ⊇ exampleIds. When the caller explicitly
      // overwrites appearsInIds, union in exampleIds before writing. Otherwise
      // use arrayUnion so concurrent writers are not clobbered.
      if (opts.appearsInIds) {
        const appearsSet = new Set<string>(opts.appearsInIds);
        for (const exId of opts.exampleIds) appearsSet.add(exId);
        data.appearsInIds = [...appearsSet];
      } else if (opts.exampleIds.length > 0) {
        data.appearsInIds = FieldValue.arrayUnion(...opts.exampleIds);
      }
    } else if (opts?.appearsInIds) {
      // Preserve invariant even when only appearsInIds is being updated:
      // always include the word's own exampleIds. The read of oldData is
      // acceptable here because the caller is explicitly overwriting.
      const existingExampleIds = (oldData.exampleIds ?? []) as string[];
      const appearsSet = new Set<string>(opts.appearsInIds);
      for (const exId of existingExampleIds) appearsSet.add(exId);
      data.appearsInIds = [...appearsSet];
    }
  } else if (Array.isArray(updates.examples) && Array.isArray(oldData.examples)) {
    // Legacy format: preserve per-example segments when sentence text is unchanged
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

  const raw = docToWord(updated);
  const [hydrated] = await hydrateWords([raw]);
  return hydrated;
}

export async function deleteWord(language: string, wordId: string): Promise<boolean> {
  const doc = await words.doc(wordId).get();
  if (!doc.exists) return false;
  const d = doc.data()!;
  const term = d.term as string;

  // Delete example sentences that are no longer referenced by any other word
  // OR by any grammar item. The cross-domain check is required: a vocab word
  // and a grammar item can share an `example_sentences` doc via the sha256
  // dedup index — deleting the word must not clobber the grammar-owned copy.
  const exampleIds = (d.exampleIds ?? []) as string[];
  if (exampleIds.length > 0) {
    const toDelete: string[] = [];
    for (const exId of exampleIds) {
      const referenced = await isExampleReferencedByAny(language, exId, { exceptWordId: wordId });
      if (!referenced) toDelete.push(exId);
    }
    if (toDelete.length > 0) {
      await deleteExampleSentences(toDelete);
    }
  }

  // Clear this word's ID from segments in every example sentence it appears
  // in. This is independent of whether the word had its own `exampleIds` —
  // a word can be segment-referenced without owning any examples.
  const appearsIn = (d.appearsInIds ?? []) as string[];
  if (appearsIn.length > 0) {
    const exDocs = await getExampleSentencesByIds(appearsIn);
    for (const es of exDocs) {
      if (!es.segments) continue;
      let changed = false;
      for (const seg of es.segments) {
        if (seg.id === wordId) {
          delete seg.id;
          changed = true;
        }
      }
      if (changed) {
        await updateExampleSentence(es.id, { segments: es.segments });
      }
    }
  }

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
  if (Array.isArray(d.definitions)) {
    return (d.definitions as any[]).map((def) => ({
      partOfSpeech: def.partOfSpeech ?? "",
      text: def.text ?? {},
      ...(Array.isArray(def.pinyins) && def.pinyins.length > 0 ? { pinyins: def.pinyins } : {}),
    }));
  }
  // Backward compat: old format had definition: Record<string, string> + grammaticalCategory: string
  if (d.definition && typeof d.definition === "object") {
    return [{ partOfSpeech: (d.grammaticalCategory as string) || "", text: d.definition as Record<string, string> }];
  }
  return [];
}

function parseExample(ex: any): Example {
  return {
    sentence: ex.sentence,
    translation: ex.translation,
    segments: ex.segments?.map((seg: any) => ({
      text: seg.text,
      transliteration: seg.transliteration ?? seg.pinyin,
      ...(seg.id ? { id: seg.id } : {}),
    })),
  };
}

function docToWord(doc: FirebaseFirestore.DocumentSnapshot): WordRaw {
  const d = doc.data()!;
  const isNewFormat = Array.isArray(d.exampleIds);
  return {
    id: doc.id,
    term: d.term,
    transliteration: d.transliteration,
    definitions: normalizeDefinitions(d),
    // Old format: parse embedded examples; New format: empty (filled by hydration)
    examples: isNewFormat ? [] : (d.examples ?? []).map(parseExample),
    topics: d.topics ?? [],
    level: d.level,
    notes: d.notes,
    ...(d.hanjaReadings ? { hanjaReadings: d.hanjaReadings } : {}),
    // New format fields
    ...(isNewFormat ? { exampleIds: d.exampleIds, appearsInIds: d.appearsInIds ?? [] } : {}),
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
  const prefix = isoMap[language.toLowerCase()] ?? language.slice(0, 2).toLowerCase();

  // Atomic read-modify-write. The smart-add queue runs up to CONCURRENCY adds
  // in parallel; a plain get()-then-increment() lets two callers read the same
  // next_id and be handed the SAME word ID. The duplicate then clobbers the
  // other word's doc on .set(), leaving an orphaned word_index entry that
  // makes a non-existent word look "green"/existing. The transaction
  // serializes the increment so every caller gets a distinct ID.
  const nextId = await db.runTransaction<number>(async (tx) => {
    const doc = await tx.get(docRef);
    if (doc.exists) {
      const current = doc.data()!.next_id as number;
      tx.update(docRef, { next_id: FieldValue.increment(1) });
      return current;
    }
    tx.set(docRef, { next_id: 2 });
    return 1;
  });

  return `${prefix}-${String(nextId).padStart(6, "0")}`;
}

const ISO_MAP: Record<string, string> = {
  chinese: "zh", english: "en", french: "fr", german: "de",
  italian: "it", japanese: "ja", korean: "ko", portuguese: "pt",
  russian: "ru", spanish: "es",
};

export async function getNextExampleId(language: string): Promise<string> {
  const docRef = idMaps.doc(`example_sentences_${language}`);
  const prefix = `exs-${ISO_MAP[language.toLowerCase()] ?? language.slice(0, 2).toLowerCase()}`;

  // Atomic read-modify-write — see getNextWordId. Concurrent example creation
  // (e.g. several queued smart-adds each creating sentences) must not be handed
  // duplicate example IDs.
  const nextId = await db.runTransaction<number>(async (tx) => {
    const doc = await tx.get(docRef);
    if (doc.exists) {
      const current = doc.data()!.next_id as number;
      tx.update(docRef, { next_id: FieldValue.increment(1) });
      return current;
    }
    tx.set(docRef, { next_id: 2 });
    return 1;
  });

  return `${prefix}-${String(nextId).padStart(6, "0")}`;
}

// ========== Example Sentences ==========

function exampleSentenceIndexId(language: string, sentence: string): string {
  const hash = createHash("sha256").update(sentence).digest("hex").slice(0, 16);
  return `${language}_${hash}`;
}

export async function addExampleSentence(es: ExampleSentence): Promise<void> {
  const data: Record<string, unknown> = { ...es };
  delete data.id;
  await exampleSentences.doc(es.id).set(data);
  // Write dedup index
  const indexId = exampleSentenceIndexId(es.language, es.sentence);
  await exampleSentenceIndex.doc(indexId).set({ exampleId: es.id });
}

export async function getExampleSentencesByIds(ids: string[]): Promise<ExampleSentence[]> {
  if (ids.length === 0) return [];
  const CHUNK = 100;
  const results: ExampleSentence[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const refs = ids.slice(i, i + CHUNK).map((id) => exampleSentences.doc(id));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      if (doc.exists) {
        const d = doc.data()!;
        results.push({
          id: doc.id,
          sentence: d.sentence,
          translation: d.translation,
          segments: d.segments?.map((seg: any) => ({
            text: seg.text,
            transliteration: seg.transliteration ?? seg.pinyin,
            ...(seg.id ? { id: seg.id } : {}),
          })),
          language: d.language,
        });
      }
    }
  }
  return results;
}

export async function findExampleByText(language: string, sentence: string): Promise<ExampleSentence | null> {
  const indexId = exampleSentenceIndexId(language, sentence);
  const indexDoc = await exampleSentenceIndex.doc(indexId).get();
  if (!indexDoc.exists) return null;
  const exId = indexDoc.data()!.exampleId as string;
  const doc = await exampleSentences.doc(exId).get();
  if (!doc.exists) return null;
  const d = doc.data()!;
  return {
    id: doc.id,
    sentence: d.sentence,
    translation: d.translation,
    segments: d.segments,
    language: d.language,
  };
}

export async function updateExampleSentence(id: string, updates: Partial<ExampleSentence>): Promise<void> {
  const data: Record<string, unknown> = { ...updates };
  delete data.id;

  // If the sentence text is changing, the dedup index (keyed by sha(sentence))
  // must be rekeyed. Detect by reading the existing doc's sentence + language
  // and compare. If the new text collides with a different example in the
  // language, the caller is attempting to "rename into" an already-dedup'd
  // slot — refuse so the two examples aren't silently conflated.
  if (typeof updates.sentence === "string") {
    const existing = await exampleSentences.doc(id).get();
    if (!existing.exists) {
      throw new Error(`Example sentence ${id} not found`);
    }
    const oldData = existing.data()!;
    const oldSentence = oldData.sentence as string;
    const language = oldData.language as string;
    if (oldSentence !== updates.sentence) {
      const newIndexId = exampleSentenceIndexId(language, updates.sentence);
      const newIndexDoc = await exampleSentenceIndex.doc(newIndexId).get();
      if (newIndexDoc.exists) {
        const existingId = newIndexDoc.data()!.exampleId as string;
        if (existingId !== id) {
          throw new Error(
            `Cannot rename example ${id} to "${updates.sentence}": another example (${existingId}) already uses that text`,
          );
        }
      }
      const oldIndexId = exampleSentenceIndexId(language, oldSentence);
      const batch = db.batch();
      batch.delete(exampleSentenceIndex.doc(oldIndexId));
      batch.set(exampleSentenceIndex.doc(newIndexId), { exampleId: id });
      batch.update(exampleSentences.doc(id), data);
      await batch.commit();
      return;
    }
  }

  await exampleSentences.doc(id).update(data);
}

export async function deleteExampleSentences(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Fetch docs to get sentence text for index cleanup AND segment refs for
  // cleaning up dangling `appearsInIds` pointers on other words.
  const docs = await db.getAll(...ids.map((id) => exampleSentences.doc(id)));

  // Collect the wordId -> set<exampleId> cleanup map for appearsInIds.
  const cleanupMap = new Map<string, Set<string>>();
  // Collect the grammarId -> set<exampleId> cleanup map for appearsInGrammarIds.
  // (Read from each example's own `appearsInGrammarIds`, the reverse-link list.)
  const grammarCleanupMap = new Map<string, Set<string>>();
  for (const doc of docs) {
    if (!doc.exists) continue;
    const d = doc.data()!;
    const segs = (d.segments ?? []) as { id?: string }[];
    for (const seg of segs) {
      if (!seg.id) continue;
      if (!cleanupMap.has(seg.id)) cleanupMap.set(seg.id, new Set());
      cleanupMap.get(seg.id)!.add(doc.id);
    }
    const grammarIds = (d.appearsInGrammarIds ?? []) as string[];
    for (const gId of grammarIds) {
      if (!grammarCleanupMap.has(gId)) grammarCleanupMap.set(gId, new Set());
      grammarCleanupMap.get(gId)!.add(doc.id);
    }
  }

  // Remove the about-to-be-deleted example IDs from each referenced word's
  // appearsInIds. `arrayRemove` is atomic and idempotent, so we just try the
  // update and swallow NOT_FOUND errors for words that were concurrently
  // deleted (e.g., the owner being removed in the surrounding deleteWord).
  for (const [wId, exIds] of cleanupMap) {
    try {
      await words.doc(wId).update({ appearsInIds: FieldValue.arrayRemove(...exIds) });
    } catch (e: unknown) {
      const code = (e as { code?: number | string }).code;
      if (code !== 5 && code !== "not-found") throw e;
    }
  }

  // Mirror the cleanup for grammar items: strip the about-to-be-deleted
  // example IDs from each referenced grammar's exampleIds.
  for (const [gId, exIds] of grammarCleanupMap) {
    try {
      await grammarItems.doc(gId).update({ exampleIds: FieldValue.arrayRemove(...exIds) });
    } catch (e: unknown) {
      const code = (e as { code?: number | string }).code;
      if (code !== 5 && code !== "not-found") throw e;
    }
  }

  // Batch delete the example sentence docs and their dedup index entries.
  const BATCH_LIMIT = 500;
  let batch = db.batch();
  let count = 0;
  for (const doc of docs) {
    if (!doc.exists) continue;
    const d = doc.data()!;
    batch.delete(doc.ref);
    const indexId = exampleSentenceIndexId(d.language, d.sentence);
    batch.delete(exampleSentenceIndex.doc(indexId));
    count += 2;
    if (count >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

export async function getAllExampleSentencesForLanguage(language: string): Promise<ExampleSentence[]> {
  const snap = await exampleSentences.where("language", "==", language).get();
  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      sentence: d.sentence,
      translation: d.translation,
      segments: d.segments,
      language: d.language,
    };
  });
}

/**
 * Reverse-link: find existing example sentences where a word appears as a segment,
 * set the segment's word ID, then set `appearsInIds` to the full invariant union
 * of (segment matches) ∪ (existing appearsInIds) ∪ (word's own exampleIds).
 */
export async function linkWordToExistingExamples(language: string, wordId: string, term: string): Promise<string[]> {
  const allEx = await getAllExampleSentencesForLanguage(language);
  const segmentMatched: string[] = [];
  const updatePromises: Promise<void>[] = [];
  for (const es of allEx) {
    if (!es.segments) continue;
    let changed = false;
    for (const seg of es.segments) {
      if (seg.text === term && !seg.id) {
        seg.id = wordId;
        changed = true;
      }
    }
    if (changed) {
      updatePromises.push(updateExampleSentence(es.id, { segments: es.segments }));
      segmentMatched.push(es.id);
    }
  }
  await Promise.all(updatePromises);

  // Union the segment-matched IDs into appearsInIds atomically. The word's
  // own exampleIds are already included by `addWord` / `updateWord` at write
  // time, so there's no need to re-read them here. `arrayUnion` is atomic
  // and idempotent, so concurrent writes are not clobbered.
  if (segmentMatched.length > 0) {
    await Promise.all(
      segmentMatched.map((esId) =>
        words.doc(wordId).update({ appearsInIds: FieldValue.arrayUnion(esId) }).catch((e: unknown) => {
          const code = (e as { code?: number | string }).code;
          if (code !== 5 && code !== "not-found") throw e;
        })
      )
    );
  }
  return segmentMatched;
}

/**
 * Reconcile `appearsInIds` on words referenced by an example sentence's segments
 * when that example sentence's segments array changes.
 *
 * - Words dropped from references: `appearsInIds` loses the example ID, unless
 *   the example is still in the word's own `exampleIds` (invariant keeps it).
 * - Words newly referenced: `appearsInIds` gains the example ID.
 */
export async function reconcileExampleSegmentRefs(
  exampleId: string,
  oldSegments: { id?: string }[] | undefined,
  newSegments: { id?: string }[] | undefined,
): Promise<void> {
  const oldIds = new Set<string>();
  for (const seg of oldSegments ?? []) if (seg.id) oldIds.add(seg.id);
  const newIds = new Set<string>();
  for (const seg of newSegments ?? []) if (seg.id) newIds.add(seg.id);

  // Words dropped from references. The decision to arrayRemove depends on a
  // read of `exampleIds` — run it in a per-word transaction so a concurrent
  // write that adds this example to the word's own exampleIds cannot sneak
  // in between the read and the remove.
  for (const wId of oldIds) {
    if (newIds.has(wId)) continue;
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(words.doc(wId));
      if (!doc.exists) return;
      const d = doc.data()!;
      const ownExampleIds = (d.exampleIds ?? []) as string[];
      if (ownExampleIds.includes(exampleId)) return; // invariant keeps it
      tx.update(words.doc(wId), { appearsInIds: FieldValue.arrayRemove(exampleId) });
    });
  }

  // Words newly referenced — arrayUnion is atomic and idempotent, so no
  // read is needed. Swallow NOT_FOUND for concurrently-deleted words.
  for (const wId of newIds) {
    if (oldIds.has(wId)) continue;
    try {
      await words.doc(wId).update({ appearsInIds: FieldValue.arrayUnion(exampleId) });
    } catch (e: unknown) {
      const code = (e as { code?: number | string }).code;
      if (code !== 5 && code !== "not-found") throw e;
    }
  }
}

/**
 * Delete a word if, and only if, it has no remaining references anywhere
 * (no own example IDs AND no segment references across other examples).
 *
 * Relies on the word↔example invariant: `appearsInIds ⊇ exampleIds`, so
 * `appearsInIds.length === 0 && exampleIds.length === 0` is a reliable
 * "fully orphaned" check. Uses a transactional read so a concurrent write
 * that re-links the word cannot race with the delete decision.
 */
export async function deleteWordIfOrphaned(
  language: string,
  wordId: string,
): Promise<boolean> {
  const shouldDelete = await db.runTransaction<boolean>(async (tx) => {
    const doc = await tx.get(words.doc(wordId));
    if (!doc.exists) return false;
    const d = doc.data()!;
    const exampleIds = (d.exampleIds ?? []) as string[];
    const appearsInIds = (d.appearsInIds ?? []) as string[];
    return exampleIds.length === 0 && appearsInIds.length === 0;
  });
  if (!shouldDelete) return false;
  await deleteWord(language, wordId);
  return true;
}

/**
 * Remove one or more example IDs from a word's `appearsInIds`. `updateWord`
 * only `arrayUnion`s into `appearsInIds`, so callers that shrink
 * `exampleIds` must also strip the same ids from `appearsInIds` when the
 * word is no longer referenced via those examples (neither as own-example
 * nor as a segment). Atomic and idempotent.
 */
export async function removeFromAppearsInIds(
  wordId: string,
  exIds: string[],
): Promise<void> {
  if (exIds.length === 0) return;
  try {
    await words.doc(wordId).update({
      appearsInIds: FieldValue.arrayRemove(...exIds),
    });
  } catch (e: unknown) {
    const code = (e as { code?: number | string }).code;
    if (code !== 5 && code !== "not-found") throw e;
  }
}

/**
 * Return true if any word other than `exceptWordId` still references
 * `exampleId` in its `appearsInIds`. Since the invariant guarantees
 * `appearsInIds ⊇ exampleIds`, querying `appearsInIds` alone catches
 * both owned references and segment references.
 *
 * NOTE: This only checks vocab-side references. For full cross-domain
 * orphan checks (vocab + grammar), prefer `isExampleReferencedByAny`.
 */
export async function isExampleReferencedByOtherWord(
  language: string,
  exampleId: string,
  exceptWordId: string,
): Promise<boolean> {
  const snap = await words
    .where("language", "==", language)
    .where("appearsInIds", "array-contains", exampleId)
    .get();
  return snap.docs.some((d) => d.id !== exceptWordId);
}

/**
 * Return true if `exampleId` is still referenced by any word or any grammar
 * item in `language`, excluding the caller-specified word/grammar IDs.
 *
 * Used by delete-cascade paths in both vocab and grammar to decide whether an
 * example sentence should be orphan-deleted. Combines the vocab `appearsInIds`
 * check with a grammar `exampleIds` check so vocab deletes don't clobber
 * grammar-owned examples, and grammar deletes don't clobber vocab-owned ones.
 */
export async function isExampleReferencedByAny(
  language: string,
  exampleId: string,
  opts: { exceptWordId?: string; exceptGrammarId?: string } = {},
): Promise<boolean> {
  const [wordSnap, grammarSnap] = await Promise.all([
    words
      .where("language", "==", language)
      .where("appearsInIds", "array-contains", exampleId)
      .get(),
    grammarItems
      .where("language", "==", language)
      .where("exampleIds", "array-contains", exampleId)
      .get(),
  ]);
  const wordRef = wordSnap.docs.some((d) => d.id !== opts.exceptWordId);
  const grammarRef = grammarSnap.docs.some((d) => d.id !== opts.exceptGrammarId);
  return wordRef || grammarRef;
}

/**
 * Unlink a word from a specific example sentence (by sentence text).
 *
 * After removing the segment link and adjusting `appearsInIds`, the word is
 * deleted only if it is fully orphaned (no remaining `exampleIds` and no
 * remaining `appearsInIds`). A word that is still segment-referenced from
 * another example stays alive.
 */
export async function unlinkWordFromExampleSentence(
  language: string,
  wordId: string,
  sentence: string,
): Promise<{ action: "deleted" | "preserved" | "noop"; word?: Word }> {
  const es = await findExampleByText(language, sentence);
  if (!es) return { action: "noop" };

  // Transactionally clear the segment link on this example and, unless the
  // example is one of the word's own examples, remove it from appearsInIds.
  // The delete decision happens afterward via deleteWordIfOrphaned so the
  // cascading multi-doc delete doesn't run inside a transaction.
  type TxResult = { kind: "noop" } | { kind: "applied" };

  const txResult = await db.runTransaction<TxResult>(async (tx) => {
    const wordDoc = await tx.get(words.doc(wordId));
    if (!wordDoc.exists) return { kind: "noop" };
    const wData = wordDoc.data()!;
    const ownExampleIds = (wData.exampleIds ?? []) as string[];

    const exDoc = await tx.get(exampleSentences.doc(es.id));
    if (!exDoc.exists) return { kind: "noop" };
    const exData = exDoc.data()!;
    const segs = (exData.segments ?? []) as Record<string, unknown>[];
    let changed = false;
    const newSegs = segs.map((seg) => {
      if (seg.id === wordId) {
        changed = true;
        const { id: _id, ...rest } = seg;
        return rest;
      }
      return seg;
    });
    if (changed) {
      tx.update(exampleSentences.doc(es.id), { segments: newSegs });
    }
    if (!ownExampleIds.includes(es.id)) {
      tx.update(words.doc(wordId), { appearsInIds: FieldValue.arrayRemove(es.id) });
    }
    return { kind: "applied" };
  });

  if (txResult.kind === "noop") return { action: "noop" };

  const deleted = await deleteWordIfOrphaned(language, wordId);
  if (deleted) return { action: "deleted" };

  // Return rehydrated word
  const updated = await words.doc(wordId).get();
  if (!updated.exists) return { action: "deleted" };
  const raw = docToWord(updated);
  const [hydrated] = await hydrateWords([raw]);
  return { action: "preserved", word: hydrated };
}

/**
 * Return the canonical pinyin for a word to use as segment transliteration.
 *
 * Monophonic words (all definitions share one distinct pinyin, or none have a
 * pinyins array) get a deterministic value. Polyphonic words (e.g. 得: de /
 * děi / dé) return undefined so the caller keeps the LLM-generated contextual
 * value rather than overriding with the wrong reading.
 */
export function getCanonicalSegmentPinyin(word: Word): string | undefined {
  const allPinyins = new Set<string>();
  for (const def of word.definitions ?? []) {
    for (const py of def.pinyins ?? []) {
      const p = py.trim();
      if (p) allPinyins.add(p);
    }
  }
  if (allPinyins.size === 1) return [...allPinyins][0];
  if (allPinyins.size === 0) return word.transliteration;
  return undefined;
}

/**
 * Reconcile incoming segments against the previous persisted segments of an
 * example sentence so that:
 *   1. A missing `id` is preserved as an explicit deactivation from the
 *      segment editor. The caller owns activation state.
 *   2. For every segment that arrives with an `id`, overwrite its
 *      `transliteration` with the canonical value from the word DB so pinyin
 *      always tracks the word (monophonic words only; polyphonic words keep
 *      their LLM-generated contextual value).
 *
 * If an id refers to a word that no longer exists, the id is cleared so we do
 * not carry a broken reference forward.
 *
 * Mutates `newSegments` in place.
 */
export async function reconcileIncomingSegments(
  _oldSegments: { text: string; transliteration?: string; id?: string }[] | undefined,
  newSegments: { text: string; transliteration?: string; id?: string }[],
): Promise<void> {
  // Source transliteration from the word DB for every segment with an id.
  const idSet = new Set<string>();
  for (const seg of newSegments) if (seg.id) idSet.add(seg.id);
  if (idSet.size === 0) return;

  const wordDocs = await getWordsByIds([...idSet]);
  const idToWord = new Map(wordDocs.map((w) => [w.id, w]));
  for (const seg of newSegments) {
    if (!seg.id) continue;
    const w = idToWord.get(seg.id);
    if (!w) {
      // Dangling id — the referenced word no longer exists. Drop the id
      // so we don't carry a broken reference forward.
      delete seg.id;
      continue;
    }
    const py = getCanonicalSegmentPinyin(w);
    if (py) seg.transliteration = py;
  }
}

/** Collect wordIds present in `oldSegments` but absent from `newSegments`. */
export function droppedSegmentWordIds(
  oldSegments: { id?: string }[] | undefined,
  newSegments: { id?: string }[] | undefined,
): string[] {
  const oldIds = new Set<string>();
  for (const seg of oldSegments ?? []) if (seg.id) oldIds.add(seg.id);
  const newIds = new Set<string>();
  for (const seg of newSegments ?? []) if (seg.id) newIds.add(seg.id);
  const dropped: string[] = [];
  for (const id of oldIds) if (!newIds.has(id)) dropped.push(id);
  return dropped;
}

/**
 * For a given example sentence, look up all segment texts in word_index
 * and set segment.id. Also update appearsInIds on matched words.
 */
export async function updateSegmentWordLinks(exampleId: string, language: string): Promise<void> {
  const doc = await exampleSentences.doc(exampleId).get();
  if (!doc.exists) return;
  const es = doc.data()!;
  if (!Array.isArray(es.segments) || es.segments.length === 0) return;

  const segTexts = [...new Set(es.segments.map((s: any) => s.text as string).filter((t: string) => t.trim()))];
  const matches = await lookupWordsByTerms(language, segTexts);
  const termToEntry = new Map(matches.map((m) => [m.term, m]));

  let changed = false;
  const newlyLinkedIds: string[] = [];
  for (const seg of es.segments) {
    const entry = termToEntry.get(seg.text);
    if (entry && !seg.id) {
      seg.id = entry.id;
      newlyLinkedIds.push(entry.id);
      changed = true;
    }
  }
  if (changed) {
    // Apply canonical pinyin for newly linked segments (monophonic words only).
    const wordDocs = await getWordsByIds([...new Set(newlyLinkedIds)]);
    const idToWord = new Map(wordDocs.map((w) => [w.id, w]));
    for (const seg of es.segments) {
      if (!seg.id) continue;
      const w = idToWord.get(seg.id);
      if (!w) continue;
      const py = getCanonicalSegmentPinyin(w);
      if (py) seg.transliteration = py;
    }
    await exampleSentences.doc(exampleId).update({ segments: es.segments });
  }

  // Update appearsInIds on matched words. `arrayUnion` is atomic and
  // idempotent; swallow NOT_FOUND for concurrently-deleted words.
  for (const [, entry] of termToEntry) {
    const wId = entry.id;
    try {
      await words.doc(wId).update({ appearsInIds: FieldValue.arrayUnion(exampleId) });
    } catch (e: unknown) {
      const code = (e as { code?: number | string }).code;
      if (code !== 5 && code !== "not-found") throw e;
    }
  }
}

/** Hydrate WordRaw[] by fetching example sentences and filling the `examples` field. */
async function hydrateWords(rawWords: WordRaw[]): Promise<Word[]> {
  // Collect all example IDs needed
  const allIds = new Set<string>();
  for (const w of rawWords) {
    if (w.exampleIds) w.exampleIds.forEach((id) => allIds.add(id));
    if (w.appearsInIds) w.appearsInIds.forEach((id) => allIds.add(id));
  }

  if (allIds.size === 0) {
    // All words are either old-format (already have examples) or have no examples
    return rawWords.map(({ exampleIds, appearsInIds, ...word }) => word);
  }

  const exSentences = await getExampleSentencesByIds([...allIds]);
  const exMap = new Map(exSentences.map((es) => [es.id, es]));

  return rawWords.map(({ exampleIds, appearsInIds, ...word }) => {
    if (!exampleIds) return word; // Old format — examples already populated

    const ownExamples: Example[] = [];
    for (const id of exampleIds) {
      const es = exMap.get(id);
      if (es) ownExamples.push({ id: es.id, sentence: es.sentence, translation: es.translation, segments: es.segments });
    }
    const appearsExamples: Example[] = [];
    for (const id of appearsInIds ?? []) {
      if (exampleIds.includes(id)) continue; // Already in own examples
      const es = exMap.get(id);
      if (es) appearsExamples.push({ id: es.id, sentence: es.sentence, translation: es.translation, segments: es.segments });
    }

    return { ...word, examples: [...ownExamples, ...appearsExamples] };
  });
}

// ========== Word Index ==========

// Return true iff the word_index entry still has a backing word doc whose term
// matches. Guards against orphaned entries (word doc missing) and mislinked
// entries (the referenced word doc now holds a different term — e.g. after a
// duplicate-ID collision). Such entries must not be reported as "existing", or
// callers like check-terms (chip "✓ exists" state) and segment linking would
// treat a ghost word as real.
function wordEntryIsLive(
  entry: WordIndexEntry,
  wordDoc: FirebaseFirestore.DocumentSnapshot,
): boolean {
  return wordDoc.exists && wordDoc.data()!.term === entry.term;
}

export async function lookupWordByTerm(language: string, term: string): Promise<WordIndexEntry | null> {
  const docId = `${language}_${term}`;
  const doc = await wordIndex.doc(docId).get();
  if (!doc.exists) return null;
  const d = doc.data()!;
  const entry: WordIndexEntry = { term: d.term, id: d.id, level: d.level, transliteration: d.transliteration ?? d.pinyin };
  const wordDoc = await words.doc(entry.id).get();
  if (!wordEntryIsLive(entry, wordDoc)) return null;
  return entry;
}

export async function lookupWordsByTerms(language: string, terms: string[]): Promise<WordIndexEntry[]> {
  const candidates: WordIndexEntry[] = [];
  const CHUNK_SIZE = 100;

  for (let i = 0; i < terms.length; i += CHUNK_SIZE) {
    const chunk = terms.slice(i, i + CHUNK_SIZE);
    const refs = chunk.map((t) => wordIndex.doc(`${language}_${t}`));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      if (doc.exists) {
        const d = doc.data()!;
        candidates.push({ term: d.term, id: d.id, level: d.level, transliteration: d.transliteration ?? d.pinyin });
      }
    }
  }

  if (candidates.length === 0) return [];

  // Verify each candidate's backing word doc (see wordEntryIsLive). Batch by
  // unique id so multiple index entries pointing at the same (clobbered) word
  // are resolved with a single read each.
  const uniqueIds = [...new Set(candidates.map((c) => c.id))];
  const liveById = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const wordDocs = await db.getAll(...chunk.map((id) => words.doc(id)));
    for (const wd of wordDocs) liveById.set(wd.id, wd);
  }

  return candidates.filter((c) => {
    const wd = liveById.get(c.id);
    return wd != null && wordEntryIsLive(c, wd);
  });
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
    groupWeights: d.groupWeights,
    groupMembership: d.groupMembership,
    correctWeight: d.correctWeight,
    correctMembership: d.correctMembership,
    pendingWordIds: d.pendingWordIds,
    questionTarget: d.questionTarget,
    flaggedOnly: d.flaggedOnly,
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

const grammarItems = db.collection("grammar_items");
const grammarGroups = db.collection("grammar_groups");
const grammarProgress = db.collection("grammar_progress");
const grammarQuizSessions = db.collection("grammar_quiz_sessions");

/**
 * Hydrate a Grammar's `examples` field from the normalized `example_sentences`
 * collection using its `exampleIds`. Preserves the existing inline `examples`
 * if the doc hasn't been migrated yet (transitional fallback).
 */
async function hydrateGrammarItems(items: Grammar[]): Promise<Grammar[]> {
  const allIds = new Set<string>();
  for (const it of items) {
    for (const id of it.exampleIds ?? []) allIds.add(id);
  }
  if (allIds.size === 0) return items;

  const docs = await getExampleSentencesByIds([...allIds]);
  const byId = new Map(docs.map((d) => [d.id, d]));

  return items.map((it) => {
    if (!it.exampleIds || it.exampleIds.length === 0) return it;
    const examples = it.exampleIds
      .map((exId) => {
        const es = byId.get(exId);
        if (!es) return null;
        return { sentence: es.sentence, translation: es.translation, ...(es.segments ? { segments: es.segments } : {}) };
      })
      .filter((ex): ex is { sentence: string; translation: string | Record<string, string> } => ex !== null);
    return { ...it, examples };
  });
}

export async function getGrammarItems(
  language: string,
  filters?: { level?: string; search?: string; groupId?: string },
  pagination?: { page: number; limit: number }
): Promise<PaginatedResult<Grammar>> {
  const page = pagination?.page ?? 1;
  const limit = pagination?.limit ?? 50;

  // Group filter: fetch group's grammarIds then apply other filters in-memory.
  let results: Grammar[];
  if (filters?.groupId) {
    const group = await getGrammarGroup(filters.groupId);
    const ids = group?.grammarIds ?? [];
    if (ids.length === 0) {
      return { items: [], total: 0, page, limit, totalPages: 1 };
    }
    const docs = await Promise.all(ids.map((id) => grammarItems.doc(id).get()));
    results = docs
      .filter((d) => d.exists && d.data()?.language === language)
      .map((d) => ({ id: d.id, ...d.data() } as Grammar));
  } else {
    let query = grammarItems.where("language", "==", language) as FirebaseFirestore.Query;
    if (filters?.level) {
      query = query.where("level", "==", filters.level);
    }
    const snap = await query.get();
    results = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Grammar));
  }

  if (filters?.search) {
    const q = filters.search.toLowerCase();
    results = results.filter((item) => (item.statement ?? "").toLowerCase().includes(q));
  }

  const total = results.length;
  const totalPages = Math.ceil(total / limit) || 1;
  const start = (page - 1) * limit;
  const items = await hydrateGrammarItems(results.slice(start, start + limit));

  return { items, total, page, limit, totalPages };
}

export async function getAllGrammarItems(language: string): Promise<Grammar[]> {
  const snap = await grammarItems.where("language", "==", language).get();
  const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Grammar));
  return hydrateGrammarItems(items);
}

/** Lightweight: fetch just the `statement` of every grammar item for a language
 *  (used by the drafts bulk-upload duplicate check — avoids hydrating examples). */
export async function getGrammarStatements(language: string): Promise<string[]> {
  const snap = await grammarItems.where("language", "==", language).select("statement").get();
  return snap.docs.map((d) => (d.data().statement as string | undefined) ?? "");
}

export async function getGrammarItem(grammarId: string): Promise<Grammar | null> {
  const doc = await grammarItems.doc(grammarId).get();
  if (!doc.exists) return null;
  const raw = { id: doc.id, ...doc.data() } as Grammar;
  const [hydrated] = await hydrateGrammarItems([raw]);
  return hydrated;
}

/**
 * Legacy whole-doc set. Prefer `addGrammar` / `updateGrammar` when the
 * caller has resolved `exampleIds` — those maintain the grammar↔example
 * back-references (`appearsInGrammarIds`) atomically. This function is kept
 * for routes that haven't been migrated yet and for callers that store
 * inline examples without normalizing them.
 */
export async function upsertGrammarItem(item: Grammar): Promise<void> {
  const data: Record<string, unknown> = { ...item };
  delete data.id;
  await grammarItems.doc(item.id).set(data);
}

/**
 * Create a grammar item with normalized example references. Mirrors `addWord`:
 *
 * - Writes `grammar_items` doc with `exampleIds` (and without inline `examples`).
 * - For every example id, atomically arrayUnion the grammar id into the
 *   example's `appearsInGrammarIds` so the reverse link is in lockstep.
 *
 * The grammar doc write and back-link writes happen in a single Firestore
 * batch (capped at 500 ops) so a partial crash leaves no orphaned half-link.
 */
export async function addGrammar(
  item: Grammar,
  opts: { exampleIds?: string[] } = {},
): Promise<void> {
  const data: Record<string, unknown> = { ...item };
  delete data.id;
  delete data.examples; // normalized — never write inline alongside exampleIds
  data.exampleIds = opts.exampleIds ?? [];

  const batch = db.batch();
  batch.set(grammarItems.doc(item.id), data);
  for (const exId of opts.exampleIds ?? []) {
    batch.update(exampleSentences.doc(exId), {
      appearsInGrammarIds: FieldValue.arrayUnion(item.id),
    });
  }
  await batch.commit();
}

/**
 * Update a grammar item, reconciling example back-references atomically.
 *
 * - If `opts.exampleIds` is provided, computes the delta vs the existing
 *   `grammar_items.exampleIds` and:
 *     · arrayUnion(grammarId) into `appearsInGrammarIds` of added examples
 *     · arrayRemove(grammarId) from `appearsInGrammarIds` of dropped examples
 * - The orphan-delete decision for dropped examples is left to the caller
 *   (route handler), which can apply `isExampleReferencedByAny` and call
 *   `deleteExampleSentences` before invoking `updateGrammar`. This mirrors
 *   the vocab PUT path's ordering: delete-then-update.
 * - All writes (grammar doc + back-link updates) happen in one batch.
 */
export async function updateGrammar(
  grammarId: string,
  patch: Partial<Grammar>,
  opts: { exampleIds?: string[] } = {},
): Promise<Grammar | null> {
  const doc = await grammarItems.doc(grammarId).get();
  if (!doc.exists) return null;
  const oldData = doc.data()!;
  const oldExampleIds = (oldData.exampleIds ?? []) as string[];

  const data: Record<string, unknown> = { ...patch };
  delete data.id;
  delete data.examples; // never coexist with exampleIds

  let added: string[] = [];
  let removed: string[] = [];
  if (opts.exampleIds) {
    const newSet = new Set(opts.exampleIds);
    const oldSet = new Set(oldExampleIds);
    added = opts.exampleIds.filter((id) => !oldSet.has(id));
    removed = oldExampleIds.filter((id) => !newSet.has(id));
    data.exampleIds = opts.exampleIds;
  }

  const batch = db.batch();
  batch.update(grammarItems.doc(grammarId), data);
  for (const exId of added) {
    batch.update(exampleSentences.doc(exId), {
      appearsInGrammarIds: FieldValue.arrayUnion(grammarId),
    });
  }
  for (const exId of removed) {
    batch.update(exampleSentences.doc(exId), {
      appearsInGrammarIds: FieldValue.arrayRemove(grammarId),
    });
  }
  await batch.commit();

  const updated = await grammarItems.doc(grammarId).get();
  return { id: updated.id, ...updated.data() } as Grammar;
}

export async function deleteGrammarItem(grammarId: string): Promise<boolean> {
  const doc = await grammarItems.doc(grammarId).get();
  if (!doc.exists) return false;
  const data = doc.data()!;
  const language = data.language as string;
  const exampleIds = (data.exampleIds ?? []) as string[];

  // Cross-domain orphan check: an example survives the grammar delete if any
  // word's appearsInIds or any other grammar item's exampleIds still references
  // it. Otherwise it is orphan-deleted.
  if (exampleIds.length > 0) {
    const toDelete: string[] = [];
    const toUnlink: string[] = [];
    for (const exId of exampleIds) {
      const referenced = await isExampleReferencedByAny(
        language,
        exId,
        { exceptGrammarId: grammarId },
      );
      if (referenced) toUnlink.push(exId);
      else toDelete.push(exId);
    }

    // For survivors, strip this grammar id from appearsInGrammarIds.
    if (toUnlink.length > 0) {
      const batch = db.batch();
      for (const exId of toUnlink) {
        batch.update(exampleSentences.doc(exId), {
          appearsInGrammarIds: FieldValue.arrayRemove(grammarId),
        });
      }
      await batch.commit();
    }

    if (toDelete.length > 0) {
      await deleteExampleSentences(toDelete);
    }
  }

  await grammarItems.doc(grammarId).delete();
  return true;
}

// ========== Word Drafts ==========

const wordDrafts = db.collection("word_drafts");

export async function getWordDrafts(language: string): Promise<WordDraft[]> {
  const snap = await wordDrafts.where("language", "==", language).get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() } as WordDraft));
  // In-memory sort avoids a composite index on language + createdAt.
  // Tiebreak by id: within one upload all drafts share createdAt, and the id
  // encodes ts + zero-padded index (see POST handler), so this keeps upload order.
  return items.sort(
    (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id)
  );
}

export async function getWordDraft(draftId: string): Promise<WordDraft | null> {
  const doc = await wordDrafts.doc(draftId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as WordDraft;
}

export async function addWordDrafts(drafts: WordDraft[]): Promise<void> {
  const batch = db.batch();
  for (const draft of drafts) {
    const { id, ...data } = draft;
    batch.set(wordDrafts.doc(id), data);
  }
  await batch.commit();
}

export async function updateWordDraft(
  draftId: string,
  updates: Partial<Omit<WordDraft, "id" | "language" | "createdAt">>
): Promise<WordDraft | null> {
  const ref = wordDrafts.doc(draftId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  const clean = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
  await ref.set(clean, { merge: true });
  const after = await ref.get();
  return { id: after.id, ...after.data() } as WordDraft;
}

export async function deleteWordDraft(draftId: string): Promise<boolean> {
  const doc = await wordDrafts.doc(draftId).get();
  if (!doc.exists) return false;
  await wordDrafts.doc(draftId).delete();
  return true;
}

// ========== Grammar Drafts ==========

const grammarDrafts = db.collection("grammar_drafts");

export async function getGrammarDrafts(language: string): Promise<GrammarDraft[]> {
  const snap = await grammarDrafts.where("language", "==", language).get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() } as GrammarDraft));
  // In-memory sort avoids a composite index on language + createdAt.
  // Tiebreak by id: within one upload all drafts share createdAt, and the id
  // encodes ts + zero-padded index (see POST handler), so this keeps upload order.
  return items.sort(
    (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id)
  );
}

export async function getGrammarDraft(draftId: string): Promise<GrammarDraft | null> {
  const doc = await grammarDrafts.doc(draftId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as GrammarDraft;
}

export async function addGrammarDrafts(drafts: GrammarDraft[]): Promise<void> {
  const batch = db.batch();
  for (const draft of drafts) {
    const { id, ...data } = draft;
    batch.set(grammarDrafts.doc(id), data);
  }
  await batch.commit();
}

export async function updateGrammarDraft(
  draftId: string,
  updates: Partial<Omit<GrammarDraft, "id" | "language" | "createdAt">>
): Promise<GrammarDraft | null> {
  const ref = grammarDrafts.doc(draftId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  const clean = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
  await ref.set(clean, { merge: true });
  const after = await ref.get();
  return { id: after.id, ...after.data() } as GrammarDraft;
}

export async function deleteGrammarDraft(draftId: string): Promise<boolean> {
  const doc = await grammarDrafts.doc(draftId).get();
  if (!doc.exists) return false;
  await grammarDrafts.doc(draftId).delete();
  return true;
}

// ========== Grammar Groups ==========

function docToGrammarGroup(doc: FirebaseFirestore.DocumentSnapshot): GrammarGroup {
  const d = doc.data()!;
  return {
    id: d.id as string,
    language: d.language as string,
    name: d.name as string,
    grammarIds: (d.grammarIds ?? []) as string[],
    createdAt: d.createdAt as string,
    // Only "B" is ever persisted — a missing field means category A, so pre-existing
    // groups become Group A with zero migration.
    ...(d.category === "B" ? { category: "B" as const } : {}),
  };
}

export async function getGrammarGroups(language: string): Promise<GrammarGroup[]> {
  const snap = await grammarGroups.where("language", "==", language).get();
  return snap.docs.map(docToGrammarGroup).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getGrammarGroup(groupId: string): Promise<GrammarGroup | null> {
  const doc = await grammarGroups.doc(groupId).get();
  return doc.exists ? docToGrammarGroup(doc) : null;
}

export async function createGrammarGroup(
  language: string,
  name: string,
  category?: GroupCategory
): Promise<GrammarGroup> {
  const id = `${language}_${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const group: GrammarGroup = {
    id,
    language,
    name,
    grammarIds: [],
    createdAt: new Date().toISOString(),
    ...(category === "B" ? { category: "B" as const } : {}),
  };
  await grammarGroups.doc(id).set(group);
  return group;
}

export async function updateGrammarGroup(groupId: string, patch: { name?: string }): Promise<GrammarGroup> {
  await grammarGroups.doc(groupId).update(patch);
  const updated = await grammarGroups.doc(groupId).get();
  return docToGrammarGroup(updated);
}

export async function deleteGrammarGroup(groupId: string): Promise<void> {
  await grammarGroups.doc(groupId).delete();
}

export async function modifyGrammarGroupMembers(
  groupId: string,
  grammarIds: string[],
  action: "add" | "remove"
): Promise<GrammarGroup> {
  return db.runTransaction(async (tx) => {
    const ref = grammarGroups.doc(groupId);
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error(`Grammar group '${groupId}' not found`);
    const current: string[] = doc.data()!.grammarIds ?? [];
    let next: string[];
    if (action === "add") {
      const toAdd = new Set(current);
      for (const id of grammarIds) toAdd.add(id);
      next = [...toAdd];
    } else {
      const toRemove = new Set(grammarIds);
      next = current.filter((id) => !toRemove.has(id));
    }
    tx.update(ref, { grammarIds: next });
    return {
      id: doc.data()!.id as string,
      language: doc.data()!.language as string,
      name: doc.data()!.name as string,
      grammarIds: next,
      createdAt: doc.data()!.createdAt as string,
      ...(doc.data()!.category === "B" ? { category: "B" as const } : {}),
    };
  });
}

/** Drop `grammarId` from every category-B group of `language`. Returns the affected group IDs. */
export async function removeGrammarFromCategoryBGroups(
  language: string,
  grammarId: string
): Promise<string[]> {
  const groups = await getGrammarGroups(language);
  const affected = groups.filter((g) => g.category === "B" && g.grammarIds.includes(grammarId));
  if (affected.length === 0) return [];
  const batch = db.batch();
  for (const g of affected) {
    batch.update(grammarGroups.doc(g.id), {
      grammarIds: g.grammarIds.filter((id) => id !== grammarId),
    });
  }
  await batch.commit();
  return affected.map((g) => g.id);
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
    groupFilter: d.groupFilter,
    groupWeights: d.groupWeights,
    groupMembership: d.groupMembership,
    correctWeight: d.correctWeight,
    correctMembership: d.correctMembership,
  };
}

export async function saveGrammarQuizSession(session: GrammarQuizSession): Promise<void> {
  const data: Record<string, unknown> = { ...session };
  delete data.sessionId;
  const clean = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined));
  await grammarQuizSessions.doc(session.language).set(clean);
}

// ========== Combined Quiz Sessions (words + grammar, keyed by language) ==========

const combinedQuizSessions = db.collection("combined_quiz_sessions");

/** Strip heavy word data — persist only what the paged hydration endpoint can't rebuild. */
function slimCombinedQuestions(questions: CombinedQuizSession["questions"]) {
  return questions.map((q) =>
    q.kind === "word"
      ? {
          kind: "word",
          wordId: q.wordId,
          term: q.term,
          ...(q.userCorrect !== undefined ? { userCorrect: q.userCorrect } : {}),
        }
      : {
          kind: "grammar",
          grammarId: q.grammarId,
          statement: q.statement,
          ...(q.userCorrect !== undefined ? { userCorrect: q.userCorrect } : {}),
        }
  );
}

/**
 * `sessionKey` is the Firestore doc ID, NOT the language: the Group B quiz reuses
 * this collection under `${language}__groupB` so both sessions can coexist.
 * `session.language` stays the plain language for the client's API calls.
 */
export async function getCombinedQuizSession(sessionKey: string): Promise<CombinedQuizSession | null> {
  const doc = await combinedQuizSessions.doc(sessionKey).get();
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
    domainWeights: d.domainWeights,
    initialTotal: d.initialTotal,
    wordGroupWeights: d.wordGroupWeights,
    wordGroupMembership: d.wordGroupMembership,
    grammarGroupWeights: d.grammarGroupWeights,
    grammarGroupMembership: d.grammarGroupMembership,
    correctWeight: d.correctWeight,
    correctMembership: d.correctMembership,
    flaggedOnly: d.flaggedOnly,
  };
}

export async function saveCombinedQuizSession(session: CombinedQuizSession): Promise<void> {
  const data: Record<string, unknown> = {
    ...session,
    questions: slimCombinedQuestions(session.questions),
  };
  delete data.sessionId;
  const clean = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined));
  // `sessionId` IS the doc key (plain language for the combined quiz, suffixed for
  // Group B) — keying off `session.language` would collapse the two sessions.
  await combinedQuizSessions.doc(session.sessionId).set(clean);
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
  limit = 20,
  language?: string
): Promise<{ entries: TranslationEntry[]; total: number }> {
  const snap = await translationHistory.orderBy("createdAt", "desc").get();
  const allDocs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) as TranslationEntry[];
  const filtered = language ? allDocs.filter((e) => e.targetLanguages?.includes(language)) : allDocs;
  const total = filtered.length;
  const offset = (page - 1) * limit;
  const entries = filtered.slice(offset, offset + limit);
  return { entries, total };
}

export async function deleteTranslationEntry(id: string): Promise<boolean> {
  const doc = await translationHistory.doc(id).get();
  if (!doc.exists) return false;
  await translationHistory.doc(id).delete();
  return true;
}

export async function clearTranslationHistory(language?: string): Promise<void> {
  const snap = language
    ? await translationHistory.where("targetLanguages", "array-contains", language).get()
    : await translationHistory.get();
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
    ...(d.expressionQuiz !== undefined ? { expressionQuiz: d.expressionQuiz } : {}),
  };
}

export async function saveSpeakingWritingSession(
  session: SpeakingWritingSession
): Promise<void> {
  const { sessionId, ...data } = session;
  const clean = Object.fromEntries(Object.entries(data).filter(([_, v]) => v !== undefined));
  await speakingWritingSessions.doc(session.language).set(clean);
}

export async function deleteSpeakingWritingSession(
  language: string
): Promise<boolean> {
  const doc = await speakingWritingSessions.doc(language).get();
  if (!doc.exists) return false;
  await speakingWritingSessions.doc(language).delete();
  return true;
}

// ========== Expressions ==========

const expressionItems = db.collection("expression_items");
const expressionGroups = db.collection("expression_groups");

function docToExpression(doc: FirebaseFirestore.DocumentSnapshot): Expression {
  const d = doc.data()!;
  return {
    id: d.id as string,
    language: d.language as string,
    phrase: d.phrase as string,
    context: d.context as string,
    ...(d.description !== undefined ? { description: d.description as string } : {}),
    ...(d.purpose !== undefined ? { purpose: d.purpose as ("speaking" | "writing")[] } : {}),
    ...(d.groupIds !== undefined ? { groupIds: d.groupIds as string[] } : {}),
  };
}

export async function getExpressions(
  language: string,
  filters?: { search?: string; purpose?: string; groupId?: string },
  pagination?: { page: number; limit: number }
): Promise<PaginatedResult<Expression>> {
  const page = pagination?.page ?? 1;
  const limit = pagination?.limit ?? 50;

  let snap: FirebaseFirestore.QuerySnapshot;
  if (filters?.groupId) {
    const group = await getExpressionGroup(filters.groupId);
    const ids = group?.expressionIds ?? [];
    if (ids.length === 0) return { items: [], total: 0, page, limit, totalPages: 1 };
    const chunks: Expression[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const batchSnap = await expressionItems.where("id", "in", batch).get();
      chunks.push(...batchSnap.docs.map(docToExpression));
    }
    let results = chunks;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      results = results.filter((e) => e.phrase.toLowerCase().includes(q) || e.context.toLowerCase().includes(q));
    }
    if (filters.purpose) {
      results = results.filter((e) => !e.purpose || e.purpose.includes(filters.purpose as "speaking" | "writing"));
    }
    const total = results.length;
    const offset = (page - 1) * limit;
    return { items: results.slice(offset, offset + limit), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  snap = await expressionItems.where("language", "==", language).get();
  let results = snap.docs.map(docToExpression);
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    results = results.filter((e) => e.phrase.toLowerCase().includes(q) || e.context.toLowerCase().includes(q));
  }
  if (filters?.purpose) {
    results = results.filter((e) => !e.purpose || e.purpose.includes(filters.purpose as "speaking" | "writing"));
  }
  const total = results.length;
  const offset = (page - 1) * limit;
  return { items: results.slice(offset, offset + limit), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getAllExpressions(language: string): Promise<Expression[]> {
  const snap = await expressionItems.where("language", "==", language).get();
  return snap.docs.map(docToExpression);
}

export async function getExpression(id: string): Promise<Expression | null> {
  const doc = await expressionItems.doc(id).get();
  return doc.exists ? docToExpression(doc) : null;
}

export async function addExpression(expr: Expression): Promise<void> {
  const { id, ...data } = expr;
  await expressionItems.doc(id).set({ id, ...data });
}

export async function updateExpression(id: string, patch: Partial<Expression>): Promise<Expression> {
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([_, v]) => v !== undefined));
  await expressionItems.doc(id).update(cleanPatch);
  const updated = await expressionItems.doc(id).get();
  return docToExpression(updated);
}

export async function deleteExpression(id: string): Promise<boolean> {
  const doc = await expressionItems.doc(id).get();
  if (!doc.exists) return false;
  await expressionItems.doc(id).delete();
  return true;
}

// ========== Expression Groups ==========

function docToExpressionGroup(doc: FirebaseFirestore.DocumentSnapshot): ExpressionGroup {
  const d = doc.data()!;
  return {
    id: d.id as string,
    language: d.language as string,
    name: d.name as string,
    expressionIds: (d.expressionIds as string[]) ?? [],
    createdAt: d.createdAt as string,
  };
}

export async function getExpressionGroups(language: string): Promise<ExpressionGroup[]> {
  const snap = await expressionGroups.where("language", "==", language).get();
  return snap.docs.map(docToExpressionGroup).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getExpressionGroup(groupId: string): Promise<ExpressionGroup | null> {
  const doc = await expressionGroups.doc(groupId).get();
  return doc.exists ? docToExpressionGroup(doc) : null;
}

export async function createExpressionGroup(language: string, name: string): Promise<ExpressionGroup> {
  const id = `${language}_${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const group: ExpressionGroup = { id, language, name, expressionIds: [], createdAt: new Date().toISOString() };
  await expressionGroups.doc(id).set(group);
  return group;
}

export async function updateExpressionGroup(groupId: string, patch: { name?: string }): Promise<ExpressionGroup> {
  await expressionGroups.doc(groupId).update(patch);
  const updated = await expressionGroups.doc(groupId).get();
  return docToExpressionGroup(updated);
}

export async function deleteExpressionGroup(groupId: string): Promise<void> {
  await expressionGroups.doc(groupId).delete();
}

export async function modifyExpressionGroupMembers(
  groupId: string,
  expressionIds: string[],
  action: "add" | "remove"
): Promise<ExpressionGroup> {
  return db.runTransaction(async (tx) => {
    const ref = expressionGroups.doc(groupId);
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error(`Expression group '${groupId}' not found`);
    const current: string[] = doc.data()!.expressionIds ?? [];
    let next: string[];
    if (action === "add") {
      const toAdd = new Set(expressionIds);
      next = [...current.filter((id) => !toAdd.has(id)), ...expressionIds];
    } else {
      const toRemove = new Set(expressionIds);
      next = current.filter((id) => !toRemove.has(id));
    }
    tx.update(ref, { expressionIds: next });
    return {
      id: doc.data()!.id as string,
      language: doc.data()!.language as string,
      name: doc.data()!.name as string,
      expressionIds: next,
      createdAt: doc.data()!.createdAt as string,
    };
  });
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

// ========== Config: Grammar ==========

export async function getGrammarConfig(): Promise<{
  smartAddSchema: Record<string, unknown>;
  smartAddPrompts: Record<string, string>;
}> {
  const doc = await db.collection("config").doc("grammar").get();
  if (!doc.exists) throw new Error("Missing config/grammar in Firestore");
  const d = doc.data()!;
  return {
    smartAddSchema: d.smartAddSchema,
    smartAddPrompts: d.smartAddPrompts,
  };
}

// ========== Config: Import (external-source article analysis) ==========

export async function getImportConfig(): Promise<{
  analyzeSchema: Record<string, unknown>;
  analyzePrompts: Record<string, string>;
}> {
  const doc = await db.collection("config").doc("import").get();
  if (!doc.exists) throw new Error("Missing config/import in Firestore");
  const d = doc.data()!;
  return {
    analyzeSchema: d.analyzeSchema,
    analyzePrompts: d.analyzePrompts,
  };
}

export async function getGrammarSettings(): Promise<GrammarSettings | null> {
  const doc = await db.collection("config").doc("grammar_settings").get();
  if (!doc.exists) return null;
  return doc.data() as GrammarSettings;
}

export async function setGrammarSettings(settings: GrammarSettings): Promise<void> {
  await db.collection("config").doc("grammar_settings").set(settings);
}

// ========== Word Groups ==========

function docToWordGroup(doc: FirebaseFirestore.DocumentSnapshot): WordGroup {
  const d = doc.data()!;
  return {
    id: d.id as string,
    language: d.language as string,
    name: d.name as string,
    wordIds: (d.wordIds ?? []) as string[],
    createdAt: d.createdAt as string,
    order: typeof d.order === "number" ? d.order : undefined,
    // Only "B" is ever persisted — a missing field means category A, so pre-existing
    // groups become Group A with zero migration.
    ...(d.category === "B" ? { category: "B" as const } : {}),
  };
}

export async function getWordGroups(language: string): Promise<WordGroup[]> {
  const snap = await wordGroups.where("language", "==", language).get();
  return snap.docs.map(docToWordGroup).sort((a, b) => {
    if (a.order !== undefined || b.order !== undefined) {
      return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
        || a.createdAt.localeCompare(b.createdAt);
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export async function getWordGroup(groupId: string): Promise<WordGroup | null> {
  const doc = await wordGroups.doc(groupId).get();
  return doc.exists ? docToWordGroup(doc) : null;
}

export async function createWordGroup(
  language: string,
  name: string,
  category?: GroupCategory
): Promise<WordGroup> {
  const existingGroups = await getWordGroups(language);
  const id = `${language}_${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const group: WordGroup = {
    id,
    language,
    name,
    wordIds: [],
    createdAt: new Date().toISOString(),
    ...(existingGroups.some((existingGroup) => existingGroup.order !== undefined)
      ? { order: existingGroups.length }
      : {}),
    ...(category === "B" ? { category: "B" as const } : {}),
  };
  await wordGroups.doc(id).set(group);
  return group;
}

export async function updateWordGroup(groupId: string, patch: { name?: string }): Promise<WordGroup> {
  await wordGroups.doc(groupId).update(patch);
  const updated = await wordGroups.doc(groupId).get();
  return docToWordGroup(updated);
}

export async function reorderWordGroups(language: string, groupIds: string[]): Promise<WordGroup[]> {
  const groups = await getWordGroups(language);
  const existingIds = new Set(groups.map((group) => group.id));
  if (
    groupIds.length !== groups.length
    || new Set(groupIds).size !== groupIds.length
    || groupIds.some((id) => !existingIds.has(id))
  ) {
    throw new Error("Group order must contain every group exactly once");
  }

  const batch = db.batch();
  groupIds.forEach((id, order) => batch.update(wordGroups.doc(id), { order }));
  await batch.commit();

  const byId = new Map(groups.map((group) => [group.id, group]));
  return groupIds.map((id, order) => ({ ...byId.get(id)!, order }));
}

export async function deleteWordGroup(groupId: string): Promise<void> {
  await wordGroups.doc(groupId).delete();
}

export async function modifyWordGroupMembers(
  groupId: string,
  wordIds: string[],
  action: "add" | "remove"
): Promise<WordGroup> {
  return db.runTransaction(async (tx) => {
    const ref = wordGroups.doc(groupId);
    const doc = await tx.get(ref);
    if (!doc.exists) throw new Error(`Group '${groupId}' not found`);
    const current: string[] = doc.data()!.wordIds ?? [];
    let next: string[];
    if (action === "add") {
      const toAdd = new Set(current);
      for (const id of wordIds) toAdd.add(id);
      next = [...toAdd];
    } else {
      const toRemove = new Set(wordIds);
      next = current.filter((id) => !toRemove.has(id));
    }
    tx.update(ref, { wordIds: next });
    return {
      id: doc.data()!.id as string,
      language: doc.data()!.language as string,
      name: doc.data()!.name as string,
      wordIds: next,
      createdAt: doc.data()!.createdAt as string,
      order: typeof doc.data()!.order === "number" ? doc.data()!.order as number : undefined,
      ...(doc.data()!.category === "B" ? { category: "B" as const } : {}),
    };
  });
}

/** Drop `wordId` from every category-B group of `language`. Returns the affected group IDs. */
export async function removeWordFromCategoryBGroups(
  language: string,
  wordId: string
): Promise<string[]> {
  const groups = await getWordGroups(language);
  const affected = groups.filter((g) => g.category === "B" && g.wordIds.includes(wordId));
  if (affected.length === 0) return [];
  const batch = db.batch();
  for (const g of affected) {
    batch.update(wordGroups.doc(g.id), { wordIds: g.wordIds.filter((id) => id !== wordId) });
  }
  await batch.commit();
  return affected.map((g) => g.id);
}

// ========== Import Sessions ==========

// Auto-ID docs rather than one-per-language: a user can have several articles
// paused at once, so this follows the translation_history pattern, not the
// singleton-per-language quiz/speaking session pattern.
const importSessions = db.collection("import_sessions");

export async function saveImportSession(
  session: Omit<ImportSession, "id">
): Promise<ImportSession> {
  const docRef = importSessions.doc();
  await docRef.set(session);
  return { id: docRef.id, ...session };
}

export async function getImportSessions(language?: string): Promise<ImportSession[]> {
  const snap = language
    ? await importSessions.where("language", "==", language).get()
    : await importSessions.get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ImportSession));
  // In-memory sort avoids a composite index on language + updatedAt.
  return items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function getImportSession(sessionId: string): Promise<ImportSession | null> {
  const doc = await importSessions.doc(sessionId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as ImportSession;
}

export async function updateImportSession(
  sessionId: string,
  updates: Partial<Omit<ImportSession, "id" | "language" | "createdAt">>
): Promise<ImportSession | null> {
  const ref = importSessions.doc(sessionId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  const clean = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
  // `items` is replaced wholesale rather than merged: a merge would leave deleted
  // rows behind, since Firestore merges arrays by replacement only at the top level.
  await ref.set({ ...clean, updatedAt: new Date().toISOString() }, { merge: true });
  const after = await ref.get();
  return { id: after.id, ...after.data() } as ImportSession;
}

export async function deleteImportSession(sessionId: string): Promise<boolean> {
  const doc = await importSessions.doc(sessionId).get();
  if (!doc.exists) return false;
  await importSessions.doc(sessionId).delete();
  return true;
}

export { db };
