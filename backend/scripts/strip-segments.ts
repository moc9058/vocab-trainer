/**
 * Strip `segments` from all example sentences in HSK JSON files.
 *
 * Usage:
 *   cd backend && npm run strip-segments
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const DB_DIR = resolve(import.meta.dirname, "..", "DB", "word");

const FILES = [
  "HSK1.json", "HSK1-extended.json",
  "HSK2.json", "HSK2-extended.json",
  "HSK3.json", "HSK3-extended.json",
  "HSK4.json", "HSK4-extended.json",
  "HSK5.json", "HSK5-extended.json",
  "HSK6.json", "HSK6-extended.json",
  "HSK7-9.json", "HSK7-9-extended.json",
];

async function main() {
  let totalStripped = 0;

  for (const filename of FILES) {
    const filepath = join(DB_DIR, filename);
    let raw: string;
    try {
      raw = await readFile(filepath, "utf-8");
    } catch {
      continue;
    }

    const data = JSON.parse(raw) as { words: { examples?: { segments?: unknown }[] }[] };
    let count = 0;

    for (const word of data.words) {
      if (!word.examples) continue;
      for (const ex of word.examples) {
        if ("segments" in ex) {
          delete ex.segments;
          count++;
        }
      }
    }

    if (count > 0) {
      await writeFile(filepath, JSON.stringify(data, null, 2) + "\n");
      console.log(`${filename}: stripped segments from ${count} examples`);
      totalStripped += count;
    } else {
      console.log(`${filename}: no segments found`);
    }
  }

  console.log(`\nTotal: stripped ${totalStripped} segments`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
