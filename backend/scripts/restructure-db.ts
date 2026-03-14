/**
 * Restructure DB: splits chinese.json into per-level files,
 * creates extended files, builds word_index.json, uploads to Firestore.
 *
 * Usage:
 *   cd backend && npm run restructure
 */

import { Firestore } from "@google-cloud/firestore";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Word } from "../src/types.js";

const DB_DIR = resolve(import.meta.dirname, "..", "DB");

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

interface WordIndexEntry {
  term: string;
  id: string;
  level: string;
  pinyin: string;
}

interface WordIndex {
  next_id: number;
  terms: Record<string, WordIndexEntry>;
}

function levelToFilename(level: string): string {
  return level.replace("~", "-");
}

async function main() {
  console.log("Reading chinese.json...");
  const raw = await readFile(join(DB_DIR, "chinese.json"), "utf-8");
  const data = JSON.parse(raw) as { words: Word[] };
  const words = data.words;
  console.log(`Found ${words.length} words`);

  // Read existing id_map for next_id
  const idMapRaw = await readFile(join(DB_DIR, "id_map_zh.json"), "utf-8");
  const idMap = JSON.parse(idMapRaw) as { next_id: number; terms: Record<string, string> };

  // Group words by level
  const byLevel = new Map<string, Word[]>();
  for (const word of words) {
    const level = word.level ?? "unknown";
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level)!.push(word);
  }

  // Write per-level files
  const levels = [...byLevel.keys()].sort();
  console.log(`Levels: ${levels.join(", ")}`);

  for (const level of levels) {
    const filename = `${levelToFilename(level)}.json`;
    const filepath = join(DB_DIR, filename);
    const levelWords = byLevel.get(level)!;
    await writeFile(filepath, JSON.stringify({ words: levelWords }, null, 2));
    console.log(`  Wrote ${filename} (${levelWords.length} words)`);

    // Write empty extended file
    const extFilename = `${levelToFilename(level)}-extended.json`;
    const extFilepath = join(DB_DIR, extFilename);
    await writeFile(extFilepath, JSON.stringify({ words: [] }, null, 2));
    console.log(`  Wrote ${extFilename} (empty)`);
  }

  // Build word_index
  const wordIndex: WordIndex = {
    next_id: idMap.next_id,
    terms: {},
  };

  for (const word of words) {
    wordIndex.terms[word.term] = {
      term: word.term,
      id: word.id,
      level: word.level ?? "",
      pinyin: word.transliteration ?? "",
    };
  }

  await writeFile(
    join(DB_DIR, "word_index.json"),
    JSON.stringify(wordIndex, null, 2)
  );
  console.log(`Wrote word_index.json (${Object.keys(wordIndex.terms).length} entries)`);

  // Upload word_index entries to Firestore
  console.log("Uploading word_index to Firestore...");
  const wordIndexCol = db.collection("word_index");
  const entries = Object.entries(wordIndex.terms);
  const BATCH_SIZE = 500; // Firestore batch limit

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = entries.slice(i, i + BATCH_SIZE);
    for (const [term, entry] of chunk) {
      const docId = `chinese_${term}`;
      batch.set(wordIndexCol.doc(docId), {
        language: "chinese",
        ...entry,
      });
    }
    await batch.commit();
    console.log(`  Uploaded batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(entries.length / BATCH_SIZE)}`);
  }

  // Slim down id_maps/chinese in Firestore to just { next_id }
  console.log("Updating id_maps/chinese in Firestore...");
  await db.collection("id_maps").doc("chinese").set({ next_id: idMap.next_id });
  console.log("  Set id_maps/chinese to { next_id: " + idMap.next_id + " }");

  // Update languages/chinese with levels array
  console.log("Updating languages/chinese with levels...");
  await db.collection("languages").doc("chinese").set(
    { levels },
    { merge: true }
  );
  console.log(`  Set levels: [${levels.join(", ")}]`);

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
