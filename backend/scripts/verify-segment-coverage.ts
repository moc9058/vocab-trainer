/**
 * Verify that all non-punctuation segments in example sentences
 * have a corresponding word entry in the database (cross-level).
 *
 * Usage: npx tsx scripts/verify-segment-coverage.ts [HSK1|HSK2|...]
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Word, VocabFile } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "../DB/word");

const LEVELS = ["HSK1", "HSK2", "HSK3", "HSK4", "HSK5", "HSK6", "HSK7-9"];

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

interface MissingSegment {
  text: string;
  sourceWords: Set<string>;
}

interface LevelReport {
  level: string;
  regularCount: number;
  extendedCount: number;
  segmentsChecked: number;
  missing: Map<string, MissingSegment>;
  orphans: string[];
}

// Build global known terms across ALL levels
const globalKnownTerms = new Set<string>();
for (const level of LEVELS) {
  for (const suffix of ["", "-extended"]) {
    try {
      const file = readJSON<VocabFile>(resolve(DB_DIR, `${level}${suffix}.json`));
      for (const word of file.words) globalKnownTerms.add(word.term);
    } catch { /* file may not exist */ }
  }
}

// Build global used terms (segments across ALL levels)
const globalUsedTerms = new Set<string>();
for (const level of LEVELS) {
  for (const suffix of ["", "-extended"]) {
    try {
      const file = readJSON<VocabFile>(resolve(DB_DIR, `${level}${suffix}.json`));
      for (const word of file.words) {
        for (const example of word.examples) {
          if (!example.segments) continue;
          for (const seg of example.segments) {
            if (seg.transliteration) globalUsedTerms.add(seg.text);
          }
        }
      }
    } catch { /* file may not exist */ }
  }
}

function checkLevel(level: string): LevelReport {
  const regularFile = readJSON<VocabFile>(resolve(DB_DIR, `${level}.json`));
  let extendedFile: VocabFile = { words: [] };
  try {
    extendedFile = readJSON<VocabFile>(resolve(DB_DIR, `${level}-extended.json`));
  } catch {
    // Extended file may not exist
  }

  const allWords = [...regularFile.words, ...extendedFile.words];
  const levelTerms = new Set(allWords.map((w) => w.term));

  const missing = new Map<string, MissingSegment>();
  let segmentsChecked = 0;

  for (const word of allWords) {
    for (const example of word.examples) {
      if (!example.segments) continue;
      for (const seg of example.segments) {
        if (!seg.transliteration) continue; // skip punctuation
        segmentsChecked++;
        if (!globalKnownTerms.has(seg.text)) {
          const entry = missing.get(seg.text);
          if (entry) {
            entry.sourceWords.add(word.term);
          } else {
            missing.set(seg.text, {
              text: seg.text,
              sourceWords: new Set([word.term]),
            });
          }
        }
      }
    }
  }

  // Orphan: word exists in this level but never used as a segment in ANY level
  const orphans = Array.from(levelTerms).filter((t) => !globalUsedTerms.has(t));

  return {
    level,
    regularCount: regularFile.words.length,
    extendedCount: extendedFile.words.length,
    segmentsChecked,
    missing,
    orphans,
  };
}

// Allow filtering to a single level via CLI arg
const filterLevel = process.argv[2];
const levels = filterLevel ? [filterLevel] : LEVELS;

console.log("=== Segment Coverage Report ===\n");

let totalMissing = 0;
let totalOrphans = 0;
const jsonReport: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  summary: { totalMissing: 0, totalOrphans: 0, levelsChecked: levels.length },
  levels: {} as Record<string, unknown>,
};

for (const level of levels) {
  const report = checkLevel(level);
  const missingCount = report.missing.size;
  const orphanCount = report.orphans.length;
  totalMissing += missingCount;
  totalOrphans += orphanCount;

  const missingArray = Array.from(report.missing.values()).map((entry) => ({
    term: entry.text,
    sourceWords: Array.from(entry.sourceWords),
  }));

  (jsonReport.levels as Record<string, unknown>)[level] = {
    knownTerms: {
      total: report.regularCount + report.extendedCount,
      regular: report.regularCount,
      extended: report.extendedCount,
    },
    segmentsChecked: report.segmentsChecked,
    missingCount,
    missing: missingArray,
    orphanCount,
    orphans: report.orphans,
  };

  console.log(`--- ${report.level} ---`);
  console.log(
    `Known terms: ${report.regularCount + report.extendedCount} (regular: ${report.regularCount}, extended: ${report.extendedCount})`
  );
  console.log(`Segments checked: ${report.segmentsChecked}`);
  console.log(`Missing segments: ${missingCount}`);
  console.log(`Orphan words: ${orphanCount}`);

  if (missingCount > 0) {
    console.log("  Missing:");
    for (const [, entry] of report.missing) {
      const sources = Array.from(entry.sourceWords).join(", ");
      console.log(`    "${entry.text}"  (in examples for: ${sources})`);
    }
  }
  if (orphanCount > 0) {
    console.log("  Orphans:");
    for (const orphan of report.orphans) {
      console.log(`    "${orphan}"`);
    }
  }
  console.log();
}

(jsonReport.summary as Record<string, unknown>).totalMissing = totalMissing;
(jsonReport.summary as Record<string, unknown>).totalOrphans = totalOrphans;

const outPath = resolve(DB_DIR, "missing-segments.json");
writeFileSync(outPath, JSON.stringify(jsonReport, null, 2), "utf-8");
console.log(`Report written to ${outPath}`);

console.log("=== Summary ===");
console.log(`Total missing segments: ${totalMissing} across ${levels.length} level(s)`);
console.log(`Total orphan words: ${totalOrphans} across ${levels.length} level(s)`);

process.exit(totalMissing > 0 ? 1 : 0);
