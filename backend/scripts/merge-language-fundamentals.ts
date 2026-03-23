/**
 * One-time script: merge Language Fundamentals sub-topics & rename pinyin fields.
 *
 * 1. Replaces topic sub-entries (Numbers & Time, Colors & Shapes, Verbs of Motion,
 *    Common Adjectives, Conjunctions & Prepositions) with "Language Fundamentals"
 * 2. Renames segments[].pinyin → segments[].transliteration in vocab files
 * 3. Renames pinyin → transliteration in word_index.json
 *
 * Usage:
 *   cd backend && npx tsx scripts/merge-language-fundamentals.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "../DB/word");

const FILES = [
  "HSK1.json", "HSK1-extended.json",
  "HSK2.json", "HSK2-extended.json",
  "HSK3.json", "HSK3-extended.json",
  "HSK4.json", "HSK4-extended.json",
  "HSK5.json", "HSK5-extended.json",
  "HSK6.json", "HSK6-extended.json",
  "HSK7-9.json", "HSK7-9-extended.json",
];

const OLD_TOPICS = new Set([
  "Numbers & Time",
  "Colors & Shapes",
  "Verbs of Motion",
  "Common Adjectives",
  "Conjunctions & Prepositions",
]);

const NEW_TOPIC = "Language Fundamentals";

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

let topicsMerged = 0;
let segmentsRenamed = 0;

for (const filename of FILES) {
  const filepath = resolve(DB_DIR, filename);
  if (!existsSync(filepath)) continue;

  const data = readJSON<{ words: any[] }>(filepath);
  let changed = false;

  for (const word of data.words) {
    // Merge topics
    const topics: string[] = word.topics ?? [];
    const hasOld = topics.some((t: string) => OLD_TOPICS.has(t));
    if (hasOld) {
      const filtered = topics.filter((t: string) => !OLD_TOPICS.has(t));
      if (!filtered.includes(NEW_TOPIC)) {
        filtered.push(NEW_TOPIC);
      }
      word.topics = filtered;
      topicsMerged++;
      changed = true;
    }

    // Rename segments[].pinyin → segments[].transliteration
    for (const ex of word.examples ?? []) {
      for (const seg of ex.segments ?? []) {
        if ("pinyin" in seg && !("transliteration" in seg)) {
          seg.transliteration = seg.pinyin;
          delete seg.pinyin;
          segmentsRenamed++;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    writeJSON(filepath, data);
    console.log(`Updated ${filename}`);
  }
}

console.log(`Merged topics for ${topicsMerged} words`);
console.log(`Renamed ${segmentsRenamed} segment pinyin → transliteration fields`);

// Rename pinyin → transliteration in word_index.json
const indexPath = resolve(DB_DIR, "word_index.json");
if (existsSync(indexPath)) {
  const index = readJSON<{ next_id: number; terms: Record<string, any> }>(indexPath);
  let indexRenamed = 0;

  for (const entry of Object.values(index.terms)) {
    if ("pinyin" in entry && !("transliteration" in entry)) {
      entry.transliteration = entry.pinyin;
      delete entry.pinyin;
      indexRenamed++;
    }
  }

  if (indexRenamed > 0) {
    writeJSON(indexPath, index);
    console.log(`Updated word_index.json: ${indexRenamed} entries renamed`);
  } else {
    console.log("word_index.json: no pinyin fields to rename");
  }
}

console.log("Done!");
