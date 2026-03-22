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
import type { VocabFile } from "../src/types.js";

/** Recursively remove empty-string keys from an object (Firestore rejects them). */
function stripEmptyKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripEmptyKeys);
  if (obj !== null && typeof obj === "object") {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k !== "") clean[k] = stripEmptyKeys(v);
    }
    return clean;
  }
  return obj;
}

const DB_DIR = resolve(import.meta.dirname, "..", "DB");

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

const isoMap: Record<string, string> = {
  chinese: "zh", english: "en", french: "fr", german: "de",
  italian: "it", japanese: "ja", korean: "ko", portuguese: "pt",
  russian: "ru", spanish: "es",
};

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const data = await readFile(path, "utf-8");
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

const COLLECTIONS_TO_CLEAR = ["languages", "words", "word_index", "id_maps"];

async function clearCollections(): Promise<void> {
  console.log("\n--- Clearing existing Firestore data ---");
  for (const name of COLLECTIONS_TO_CLEAR) {
    const coll = db.collection(name);
    let deleted = 0;
    let snap = await coll.limit(500).get();
    while (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      deleted += snap.size;
      snap = await coll.limit(500).get();
    }
    console.log(`  Cleared ${name}: ${deleted} docs`);
  }
}

// Accumulator for aggregating multiple files into a single language
interface LanguageAccumulator {
  wordCount: number;
  topics: Set<string>;
  levels: Set<string>;
  terms: Record<string, string>;
  maxIdNum: number;
}
const languageAccumulators = new Map<string, LanguageAccumulator>();

function getAccumulator(language: string): LanguageAccumulator {
  let acc = languageAccumulators.get(language);
  if (!acc) {
    acc = { wordCount: 0, topics: new Set(), levels: new Set(), terms: {}, maxIdNum: 0 };
    languageAccumulators.set(language, acc);
  }
  return acc;
}

async function migrateLanguage(filename: string): Promise<void> {
  const fileBase = filename.replace(".json", "");
  console.log(`\n--- Migrating file: ${filename} ---`);

  // Read vocab file
  const vocab = await readJson<VocabFile>(join(DB_DIR, filename));
  if (!vocab) {
    console.log(`  Skipping ${filename}: could not read`);
    return;
  }

  // Use the language field from the JSON file, falling back to filename
  const language = vocab.language ?? fileBase;
  const acc = getAccumulator(language);

  console.log(`  Language: ${language} (from ${vocab.language ? "JSON field" : "filename"})`);

  // Accumulate metadata
  for (const word of vocab.words) {
    for (const topic of word.topics) acc.topics.add(topic);
    if (word.level) acc.levels.add(word.level);
  }

  // Migrate words (batch writes, 500 per batch)
  let wordCount = 0;
  for (let i = 0; i < vocab.words.length; i += 500) {
    const batch = db.batch();
    const chunk = vocab.words.slice(i, i + 500);
    for (const word of chunk) {
      const docRef = db.collection("words").doc(word.id);
      const { id, ...wordData } = word;
      batch.set(docRef, stripEmptyKeys({ ...wordData, language }) as FirebaseFirestore.DocumentData);
      wordCount++;
    }
    await batch.commit();
    console.log(`  Words: ${Math.min(i + 500, vocab.words.length)}/${vocab.words.length}`);
  }
  acc.wordCount += wordCount;
  console.log(`  Migrated ${wordCount} words`);

  // Accumulate ID map data
  const code = isoMap[language.toLowerCase()] ?? language.slice(0, 2).toLowerCase();
  const idMapPath = join(DB_DIR, `id_map_${code}.json`);
  const idMapData = await readJson<{ next_id: number; terms: Record<string, string> }>(idMapPath);

  if (idMapData) {
    Object.assign(acc.terms, idMapData.terms);
    acc.maxIdNum = Math.max(acc.maxIdNum, idMapData.next_id);
  } else {
    for (const word of vocab.words) {
      acc.terms[word.term] = word.id;
      const match = word.id.match(/-(\d+)$/);
      if (match) acc.maxIdNum = Math.max(acc.maxIdNum, parseInt(match[1], 10));
    }
  }

  // Migrate word_index
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
        transliteration: word.transliteration ?? "",
      });
      indexCount++;
    }
    await batch.commit();
    console.log(`  Word index: ${Math.min(i + 500, vocab.words.length)}/${vocab.words.length}`);
  }
  console.log(`  Migrated ${indexCount} word_index entries`);
}

async function writeLanguageDocs(): Promise<void> {
  console.log("\n--- Writing language documents ---");
  for (const [language, acc] of languageAccumulators) {
    await db.collection("languages").doc(language).set({
      wordCount: acc.wordCount,
      topics: [...acc.topics],
      levels: [...acc.levels].sort(),
    });
    console.log(`  ${language}: wordCount=${acc.wordCount}, topics=${acc.topics.size}, levels=${acc.levels.size}`);

    // Write unified ID map
    const nextId = acc.maxIdNum + 1;
    await db.collection("id_maps").doc(language).set({
      next_id: nextId,
      terms: acc.terms,
    });
    console.log(`  ${language} ID map: next_id=${nextId}, terms=${Object.keys(acc.terms).length}`);
  }
}

async function main(): Promise<void> {
  console.log("=== Vocab Trainer: Migrate to Firestore ===");
  console.log(`DB_DIR: ${DB_DIR}`);

  // Clear all existing data before re-populating
  await clearCollections();

  // Find all vocab files
  const files = await readdir(DB_DIR);
  const vocabFiles = files.filter((f) => f.endsWith(".json") && !f.startsWith("id_map_") && !f.startsWith("word_index")).sort();
  console.log(`Found ${vocabFiles.length} vocab file(s): ${vocabFiles.join(", ")}`);

  for (const file of vocabFiles) {
    await migrateLanguage(file);
  }

  // Write aggregated language docs and ID maps
  await writeLanguageDocs();

  console.log("\n=== Migration complete ===");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
