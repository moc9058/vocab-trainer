/**
 * Export Firestore data back to local JSON files (inverse of migrate-to-firestore).
 *
 * Usage:
 *   cd backend && npx tsx scripts/export-from-firestore.ts
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or Application Default Credentials.
 */

import { Firestore } from "@google-cloud/firestore";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Word, Meaning, Example, VocabFile, WordProgress, ProgressFile, GrammarChapter, GrammarComponent } from "../src/types.js";

const DB_DIR = resolve(import.meta.dirname, "..", "DB", "word");
const GRAMMAR_DIR = resolve(import.meta.dirname, "..", "DB", "grammer");
const DATA_DIR = resolve(import.meta.dirname, "..", "data");
const PROGRESS_DIR = join(DATA_DIR, "progress");

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

/** Normalize legacy definition keys (full names → ISO codes) and grammar "kr" → "ko". */
const LANG_KEY_MAP: Record<string, string> = {
  Japanese: "ja", English: "en", Korean: "ko", kr: "ko",
};

function normalizeLangKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[LANG_KEY_MAP[k] ?? k] = v;
  }
  return out;
}

function docToWord(doc: FirebaseFirestore.DocumentSnapshot): Word {
  const d = doc.data()!;
  // Normalize old format (definition + grammaticalCategory) to new (definitions: Meaning[])
  let definitions: Meaning[];
  if (Array.isArray(d.definitions)) {
    definitions = (d.definitions as any[]).map((m: any) => ({
      partOfSpeech: m.partOfSpeech ?? "",
      text: normalizeLangKeys(m.text ?? {}),
    }));
  } else if (d.definition && typeof d.definition === "object") {
    definitions = [{ partOfSpeech: (d.grammaticalCategory as string) ?? "", text: normalizeLangKeys(d.definition ?? {}) }];
  } else {
    definitions = [];
  }

  const word: Word = {
    id: doc.id,
    term: d.term,
    definitions,
    examples: (d.examples ?? []).map((ex: any): Example => ({
      sentence: ex.sentence,
      translation: ex.translation,
      ...(ex.segments ? {
        segments: ex.segments.map((seg: any) => ({
          text: seg.text,
          ...(seg.transliteration || seg.pinyin
            ? { transliteration: seg.transliteration ?? seg.pinyin }
            : {}),
          ...(seg.id ? { id: seg.id } : {}),
        })),
      } : {}),
    })),
    topics: d.topics ?? [],
  };
  if (d.transliteration) word.transliteration = d.transliteration;
  if (d.level) word.level = d.level;
  if (d.notes) word.notes = d.notes;
  return word;
}

async function exportWords(): Promise<void> {
  console.log("\n--- Exporting words ---");
  const snap = await db.collection("words").get();
  console.log(`  Found ${snap.size} words total`);

  // Group words by language
  const byLanguage = new Map<string, Word[]>();

  for (const doc of snap.docs) {
    const d = doc.data();
    const language = (d.language as string) ?? "unknown";
    if (!byLanguage.has(language)) {
      byLanguage.set(language, []);
    }
    byLanguage.get(language)!.push(docToWord(doc));
  }

  // Write one JSON file per language
  for (const [language, words] of byLanguage) {
    words.sort((a, b) => a.id.localeCompare(b.id));
    const vocabFile: VocabFile = { language, words };
    const filename = `${language}.json`;
    const filepath = join(DB_DIR, filename);
    await writeFile(filepath, JSON.stringify(vocabFile, null, 2) + "\n", "utf-8");
    console.log(`  ${filename}: ${words.length} words`);
  }
}

async function exportProgress(): Promise<void> {
  console.log("\n--- Exporting progress ---");
  await mkdir(PROGRESS_DIR, { recursive: true });

  const snap = await db.collection("progress").get();
  console.log(`  Found ${snap.size} progress entries total`);

  // Group by language
  const byLanguage = new Map<string, Record<string, WordProgress>>();

  for (const doc of snap.docs) {
    const d = doc.data();
    const language = (d.language as string) ?? "unknown";
    if (!byLanguage.has(language)) {
      byLanguage.set(language, {});
    }
    byLanguage.get(language)![d.wordId] = {
      timesSeen: d.timesSeen ?? 0,
      timesCorrect: d.timesCorrect ?? 0,
      correctRate: d.correctRate ?? 0,
      lastReviewed: d.lastReviewed ?? "",
      streak: d.streak ?? 0,
    };
  }

  for (const [language, words] of byLanguage) {
    const progressFile: ProgressFile = { language, words };
    const filepath = join(PROGRESS_DIR, `${language}.json`);
    await writeFile(filepath, JSON.stringify(progressFile, null, 2) + "\n", "utf-8");
    console.log(`  ${language}.json: ${Object.keys(words).length} entries`);
  }
}

async function exportGrammar(): Promise<void> {
  console.log("\n--- Exporting grammar ---");
  const chapterSnap = await db.collection("grammar_chapters").get();
  const itemSnap = await db.collection("grammar_items").get();
  console.log(`  Found ${chapterSnap.size} chapters, ${itemSnap.size} grammar items total`);

  if (chapterSnap.empty) return;

  // Group chapters by language
  const chaptersByLang = new Map<string, FirebaseFirestore.DocumentData[]>();
  for (const doc of chapterSnap.docs) {
    const d = doc.data();
    const lang = d.language as string;
    if (!chaptersByLang.has(lang)) chaptersByLang.set(lang, []);
    chaptersByLang.get(lang)!.push(d);
  }

  // Group items by language → chapterNumber → subchapterId
  const itemsByLangChapterSub = new Map<string, Map<number, Map<string, GrammarComponent[]>>>();
  for (const doc of itemSnap.docs) {
    const d = doc.data();
    const lang = d.language as string;
    const chNum = d.chapterNumber as number;
    const subId = d.subchapterId as string;

    if (!itemsByLangChapterSub.has(lang)) itemsByLangChapterSub.set(lang, new Map());
    const byChapter = itemsByLangChapterSub.get(lang)!;
    if (!byChapter.has(chNum)) byChapter.set(chNum, new Map());
    const bySub = byChapter.get(chNum)!;
    if (!bySub.has(subId)) bySub.set(subId, []);

    const comp: GrammarComponent = {
      id: doc.id,
      term: normalizeLangKeys(d.title ?? {}),
      ...(d.description ? { description: normalizeLangKeys(d.description) } : {}),
      ...(d.examples ? { examples: d.examples } : {}),
      ...(d.relatedWordIds ? { words: d.relatedWordIds } : {}),
      ...(d.level ? { level: d.level } : {}),
      ...(d.tags ? { tags: d.tags } : {}),
    };
    bySub.get(subId)!.push(comp);
  }

  // Reconstruct and write per-chapter JSON files
  for (const [language, chapters] of chaptersByLang) {
    const langDir = join(GRAMMAR_DIR, language);
    await mkdir(langDir, { recursive: true });

    for (const chData of chapters) {
      const chNum = chData.chapterNumber as number;
      const itemsByChapter = itemsByLangChapterSub.get(language)?.get(chNum) ?? new Map();

      const chapter: GrammarChapter = {
        chapter: chData.chapterTitle?.ja ?? `Chapter ${chNum}`,
        chapterNumber: chNum,
        chapterTitle: normalizeLangKeys(chData.chapterTitle ?? {}),
        language,
        subchapters: (chData.subchapters ?? []).map((s: any) => ({
          id: s.id,
          title: normalizeLangKeys(s.title ?? {}),
          components: itemsByChapter.get(s.id) ?? [],
        })),
      };

      const filename = `${chNum}. ${chData.chapterTitle?.ja ?? `Chapter ${chNum}`}.json`;
      const filepath = join(langDir, filename);
      await writeFile(filepath, JSON.stringify(chapter, null, 2) + "\n", "utf-8");
      console.log(`  ${language}/${filename}`);
    }
  }
}

async function main(): Promise<void> {
  console.log("=== Vocab Trainer: Export from Firestore ===");
  console.log(`DB_DIR: ${DB_DIR}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);

  await exportWords();
  await exportGrammar();
  await exportProgress();

  console.log("\n=== Export complete ===");
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
