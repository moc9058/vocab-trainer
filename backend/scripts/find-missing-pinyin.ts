/**
 * Scan all example sentences across HSK files, segment using word_index,
 * and report multi-char substrings that have no pinyin mapping.
 *
 * Usage: npx tsx scripts/find-missing-pinyin.ts
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Word } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "../DB/word");

const LEVELS = ["HSK1", "HSK2", "HSK3", "HSK4", "HSK5", "HSK6", "HSK7-9"];

interface WordIndex {
  next_id: number;
  terms: Record<string, { term: string; id: string; level: string; transliteration: string }>;
}

interface VocabFile {
  words: Word[];
}

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

// Build term set from word_index
const wordIndex = readJSON<WordIndex>(resolve(DB_DIR, "word_index.json"));
const termSet = new Set(Object.keys(wordIndex.terms));
const maxLen = Math.max(0, ...Array.from(termSet).map((t) => t.length));

// Collect all example sentences
const sentences: string[] = [];
for (const level of LEVELS) {
  for (const suffix of ["", "-extended"]) {
    const path = resolve(DB_DIR, `${level}${suffix}.json`);
    try {
      const file = readJSON<VocabFile>(path);
      for (const word of file.words) {
        for (const ex of word.examples ?? []) {
          sentences.push(ex.sentence);
        }
      }
    } catch {
      // file may not exist
    }
  }
}

// Greedy longest-match segmentation, collect unmatched multi-char substrings
const missing = new Map<string, number>();
const punctuation = /^[\p{P}\p{S}\p{Z}\p{N}\p{M}\s\d\w]+$/u;

for (const sentence of sentences) {
  let i = 0;
  while (i < sentence.length) {
    let matched = false;
    const end = Math.min(i + maxLen, sentence.length);

    for (let len = end - i; len >= 1; len--) {
      const substr = sentence.slice(i, i + len);
      if (termSet.has(substr)) {
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Collect contiguous unmatched characters
      let unmatchedStart = i;
      i++;
      while (i < sentence.length) {
        // Try matching from current position
        let found = false;
        const end2 = Math.min(i + maxLen, sentence.length);
        for (let len = end2 - i; len >= 1; len--) {
          if (termSet.has(sentence.slice(i, i + len))) {
            found = true;
            break;
          }
        }
        if (found) break;
        i++;
      }

      const chunk = sentence.slice(unmatchedStart, i);
      // Only report multi-char Chinese substrings (skip punctuation, spaces, single chars)
      if (chunk.length >= 2 && !punctuation.test(chunk)) {
        missing.set(chunk, (missing.get(chunk) ?? 0) + 1);
      }
    }
  }
}

// Sort by frequency descending
const sorted = [...missing.entries()].sort((a, b) => b[1] - a[1]);

console.log(`Found ${sorted.length} missing multi-char terms across ${sentences.length} sentences:\n`);
for (const [term, count] of sorted) {
  console.log(`  ${term}  (${count}x)`);
}
