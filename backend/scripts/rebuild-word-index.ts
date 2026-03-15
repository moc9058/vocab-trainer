/**
 * Rebuild word_index.json from all HSK*.json and HSK*-extended.json files.
 *
 * - Removes orphaned index entries (words no longer in any file)
 * - Removes duplicate terms (keeps base-level over extended, lower level wins)
 * - Reassigns sequential IDs (zh-000001, zh-000002, ...)
 * - Updates HSK files in place with new IDs
 * - Rebuilds word_index.json with correct next_id
 *
 * Usage:
 *   cd backend && npm run rebuild-index
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { globSync } from "node:fs";

const DB_DIR = resolve(import.meta.dirname, "..", "DB");

interface Word {
  id: string;
  term: string;
  transliteration?: string;
  level?: string;
  [key: string]: unknown;
}

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

// Ordered list of files for ID assignment
const FILE_ORDER = [
  "HSK1.json",
  "HSK1-extended.json",
  "HSK2.json",
  "HSK2-extended.json",
  "HSK3.json",
  "HSK3-extended.json",
  "HSK4.json",
  "HSK4-extended.json",
  "HSK5.json",
  "HSK5-extended.json",
  "HSK6.json",
  "HSK6-extended.json",
  "HSK7-9.json",
  "HSK7-9-extended.json",
];

async function main() {
  // 1. Read all files
  const fileData = new Map<string, { words: Word[] }>();
  for (const filename of FILE_ORDER) {
    const filepath = join(DB_DIR, filename);
    try {
      const raw = await readFile(filepath, "utf-8");
      const data = JSON.parse(raw) as { words: Word[] };
      fileData.set(filename, data);
      console.log(`Read ${filename}: ${data.words.length} words`);
    } catch {
      console.log(`Skipped ${filename} (not found)`);
    }
  }

  // 2. Deduplicate: track seen terms, base files take priority over extended
  const seenTerms = new Set<string>();
  let duplicatesRemoved = 0;

  for (const filename of FILE_ORDER) {
    const data = fileData.get(filename);
    if (!data) continue;

    const filtered: Word[] = [];
    for (const word of data.words) {
      if (seenTerms.has(word.term)) {
        duplicatesRemoved++;
        console.log(`  Duplicate removed: "${word.term}" in ${filename}`);
      } else {
        seenTerms.add(word.term);
        filtered.push(word);
      }
    }
    data.words = filtered;
  }

  console.log(`\nDuplicates removed: ${duplicatesRemoved}`);

  // 3. Reassign sequential IDs and build word_index
  let nextId = 1;
  const wordIndex: WordIndex = { next_id: 0, terms: {} };

  for (const filename of FILE_ORDER) {
    const data = fileData.get(filename);
    if (!data) continue;

    const level = filename.replace(".json", "").replace("-extended", "-extended");

    for (const word of data.words) {
      const newId = `zh-${String(nextId).padStart(6, "0")}`;
      word.id = newId;

      wordIndex.terms[word.term] = {
        term: word.term,
        id: newId,
        level: word.level ?? "",
        pinyin: word.transliteration ?? "",
      };

      nextId++;
    }
  }

  wordIndex.next_id = nextId;

  // 4. Write updated HSK files
  console.log("\nWriting updated files:");
  for (const filename of FILE_ORDER) {
    const data = fileData.get(filename);
    if (!data) continue;

    await writeFile(
      join(DB_DIR, filename),
      JSON.stringify(data, null, 2) + "\n"
    );
    console.log(`  ${filename}: ${data.words.length} words`);
  }

  // 5. Write word_index.json
  await writeFile(
    join(DB_DIR, "word_index.json"),
    JSON.stringify(wordIndex, null, 2) + "\n"
  );

  const totalWords = nextId - 1;
  console.log(`\nword_index.json: ${Object.keys(wordIndex.terms).length} entries`);
  console.log(`next_id: ${wordIndex.next_id}`);
  console.log(`Total words: ${totalWords}`);
  console.log("Done!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
