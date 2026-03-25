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
import type { Word, Example, VocabFile, WordProgress, ProgressFile } from "../src/types.js";

const DB_DIR = resolve(import.meta.dirname, "..", "DB", "word");
const DATA_DIR = resolve(import.meta.dirname, "..", "data");
const PROGRESS_DIR = join(DATA_DIR, "progress");

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

function docToWord(doc: FirebaseFirestore.DocumentSnapshot): Word {
  const d = doc.data()!;
  const word: Word = {
    id: doc.id,
    term: d.term,
    definition: d.definition ?? {},
    grammaticalCategory: d.grammaticalCategory ?? "",
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

async function main(): Promise<void> {
  console.log("=== Vocab Trainer: Export from Firestore ===");
  console.log(`DB_DIR: ${DB_DIR}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);

  await exportWords();
  await exportProgress();

  console.log("\n=== Export complete ===");
}

main().catch((err) => {
  console.error("Export failed:", err);
  process.exit(1);
});
