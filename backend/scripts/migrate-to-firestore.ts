/**
 * One-time migration script: imports existing JSON data into Firestore.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-to-firestore.ts
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or Application Default Credentials.
 */

import { Firestore } from "@google-cloud/firestore";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import type { VocabFile, ProgressFile, QuizSession } from "../src/types.js";

interface QuizHistoryFile {
  sessions: QuizSession[];
}

const DB_DIR = resolve(import.meta.dirname, "..", "DB");
const DATA_DIR = resolve(import.meta.dirname, "..", "data");
const PROGRESS_DIR = join(DATA_DIR, "progress");
const QUIZ_HISTORY_PATH = join(DATA_DIR, "quiz-history.json");

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

async function migrateLanguage(filename: string): Promise<void> {
  const language = filename.replace(".json", "");
  console.log(`\n--- Migrating language: ${language} ---`);

  // Read vocab file
  const vocab = await readJson<VocabFile>(join(DB_DIR, filename));
  if (!vocab) {
    console.log(`  Skipping ${filename}: could not read`);
    return;
  }

  // 1. Create language document
  const topics = [...new Set(vocab.words.flatMap((w) => w.topics))];
  await db.collection("languages").doc(language).set({
    wordCount: vocab.words.length,
    topics,
  });
  console.log(`  Created language doc: wordCount=${vocab.words.length}, topics=${topics.length}`);

  // 2. Migrate words (batch writes, 500 per batch)
  let wordCount = 0;
  for (let i = 0; i < vocab.words.length; i += 500) {
    const batch = db.batch();
    const chunk = vocab.words.slice(i, i + 500);
    for (const word of chunk) {
      const docRef = db.collection("words").doc(word.id);
      const { id, ...wordData } = word;
      batch.set(docRef, { ...wordData, language });
      wordCount++;
    }
    await batch.commit();
    console.log(`  Words: ${Math.min(i + 500, vocab.words.length)}/${vocab.words.length}`);
  }
  console.log(`  Migrated ${wordCount} words`);

  // 3. Migrate ID map
  const isoMap: Record<string, string> = {
    chinese: "zh", english: "en", french: "fr", german: "de",
    italian: "it", japanese: "ja", korean: "ko", portuguese: "pt",
    russian: "ru", spanish: "es",
  };
  const code = isoMap[language.toLowerCase()] ?? language.slice(0, 2).toLowerCase();
  const idMapPath = join(DB_DIR, `id_map_${code}.json`);
  const idMapData = await readJson<{ next_id: number; terms: Record<string, string> }>(idMapPath);

  if (idMapData) {
    // Firestore has a 1MB document limit. For large term maps, we may need to split.
    // With ~10K terms, each entry ~30 bytes, ~300KB — well within limits.
    await db.collection("id_maps").doc(language).set({
      next_id: idMapData.next_id,
      terms: idMapData.terms,
    });
    console.log(`  Migrated ID map: next_id=${idMapData.next_id}, terms=${Object.keys(idMapData.terms).length}`);
  } else {
    // Generate ID map from words
    const terms: Record<string, string> = {};
    let maxNum = 0;
    for (const word of vocab.words) {
      terms[word.term] = word.id;
      const match = word.id.match(/-(\d+)$/);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
    await db.collection("id_maps").doc(language).set({
      next_id: maxNum + 1,
      terms,
    });
    console.log(`  Generated ID map: next_id=${maxNum + 1}, terms=${Object.keys(terms).length}`);
  }

  // 4. Migrate progress
  const progressPath = join(PROGRESS_DIR, `${language}.json`);
  const progressData = await readJson<ProgressFile>(progressPath);
  if (progressData && Object.keys(progressData.words).length > 0) {
    const entries = Object.entries(progressData.words);
    let progressCount = 0;
    for (let i = 0; i < entries.length; i += 500) {
      const batch = db.batch();
      const chunk = entries.slice(i, i + 500);
      for (const [wordId, wp] of chunk) {
        const docId = `${language}_${wordId}`;
        batch.set(db.collection("progress").doc(docId), {
          language,
          wordId,
          ...wp,
        });
        progressCount++;
      }
      await batch.commit();
    }
    console.log(`  Migrated ${progressCount} progress entries`);
  } else {
    console.log(`  No progress data found`);
  }

  // 5. Migrate word_index
  let indexCount = 0;
  for (let i = 0; i < vocab.words.length; i += 500) {
    const batch = db.batch();
    const chunk = vocab.words.slice(i, i + 500);
    for (const word of chunk) {
      const docId = `${language}_${word.term}`;
      batch.set(db.collection("word_index").doc(docId), {
        language,
        term: word.term,
        id: word.id,
        level: word.level ?? "",
        pinyin: word.transliteration ?? "",
      });
      indexCount++;
    }
    await batch.commit();
    console.log(`  Word index: ${Math.min(i + 500, vocab.words.length)}/${vocab.words.length}`);
  }
  console.log(`  Migrated ${indexCount} word_index entries`);
}

async function migrateQuizHistory(): Promise<void> {
  console.log(`\n--- Migrating quiz history ---`);
  const history = await readJson<QuizHistoryFile>(QUIZ_HISTORY_PATH);
  if (!history || history.sessions.length === 0) {
    console.log(`  No quiz history found`);
    return;
  }

  let count = 0;
  for (let i = 0; i < history.sessions.length; i += 500) {
    const batch = db.batch();
    const chunk = history.sessions.slice(i, i + 500);
    for (const session of chunk) {
      const { sessionId, ...data } = session;
      batch.set(db.collection("quiz_sessions").doc(sessionId), data);
      count++;
    }
    await batch.commit();
    console.log(`  Sessions: ${Math.min(i + 500, history.sessions.length)}/${history.sessions.length}`);
  }
  console.log(`  Migrated ${count} quiz sessions`);
}

async function main(): Promise<void> {
  console.log("=== Vocab Trainer: Migrate to Firestore ===");
  console.log(`DB_DIR: ${DB_DIR}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);

  // Find all vocab files
  const files = await readdir(DB_DIR);
  const vocabFiles = files.filter((f) => f.endsWith(".json") && !f.startsWith("id_map_") && !f.startsWith("word_index")).sort();
  console.log(`Found ${vocabFiles.length} language file(s): ${vocabFiles.join(", ")}`);

  for (const file of vocabFiles) {
    await migrateLanguage(file);
  }

  await migrateQuizHistory();

  console.log("\n=== Migration complete ===");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
