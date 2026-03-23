/**
 * One-time script: rename `pinyin` → `transliteration` in DB JSON files.
 *
 * 1. In all HSK*.json / HSK*-extended.json: renames segments[].pinyin → segments[].transliteration
 * 2. In word_index.json: renames each entry's `pinyin` → `transliteration`
 *
 * Usage:
 *   cd backend && npx tsx scripts/rename-pinyin-fields.ts
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

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// Rename segments[].pinyin → segments[].transliteration in vocab files
let segmentsRenamed = 0;
for (const filename of FILES) {
  const filepath = resolve(DB_DIR, filename);
  if (!existsSync(filepath)) continue;

  const data = readJSON<{ words: any[] }>(filepath);
  let changed = false;

  for (const word of data.words) {
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
