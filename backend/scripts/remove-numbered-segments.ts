/**
 * Remove numbered prefix segments (e.g. "14.") from example sentence segments.
 *
 * Usage: npx tsx scripts/remove-numbered-segments.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { VocabFile } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "../DB");

const LEVELS = ["HSK1", "HSK2", "HSK3", "HSK4", "HSK5", "HSK6", "HSK7-9"];
const NUMBERED_RE = /^\d+\.$/;

for (const level of LEVELS) {
  for (const suffix of ["", "-extended"]) {
    const filePath = resolve(DB_DIR, `${level}${suffix}.json`);
    let file: VocabFile;
    try {
      file = JSON.parse(readFileSync(filePath, "utf-8")) as VocabFile;
    } catch {
      continue;
    }

    let removed = 0;

    for (const word of file.words) {
      for (const example of word.examples) {
        if (!example.segments) continue;
        const before = example.segments.length;
        example.segments = example.segments.filter(
          (seg) => !NUMBERED_RE.test(seg.text)
        );
        removed += before - example.segments.length;
      }
    }

    if (removed > 0) {
      writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n", "utf-8");
      console.log(`${level}${suffix}: removed ${removed} numbered segments`);
    }
  }
}

console.log("Done.");
