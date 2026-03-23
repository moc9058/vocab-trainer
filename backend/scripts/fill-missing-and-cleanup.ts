/**
 * Three-phase script:
 *   Phase 1: Remove orphan words (entries never used as segments)
 *   Phase 2: Add missing segment words via LLM (segments with no word entry)
 *   Phase 3: (run rebuild-index externally)
 *   Phase 4: Add word IDs to every segment
 *
 * Usage:
 *   npx tsx scripts/fill-missing-and-cleanup.ts              # Run phases 1+2
 *   npx tsx scripts/fill-missing-and-cleanup.ts --assign-ids  # Run phase 4 only
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  callLLM,
  validateWord,
  stripMarkdownFences,
  chunk,
  delay,
} from "../src/llm.js";
import { TOPICS, type Word, type Topic, type VocabFile, type WordIndexEntry } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "../DB/word");

const LEVELS = ["HSK1", "HSK2", "HSK3", "HSK4", "HSK5", "HSK6", "HSK7-9"];

interface WordIndex {
  next_id: number;
  terms: Record<string, WordIndexEntry>;
}

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function formatId(n: number): string {
  return `zh-${String(n).padStart(6, "0")}`;
}

// ── Phase 1: Remove orphan words ─────────────────────────────────────

function removeOrphans(): number {
  console.log("\n=== Phase 1: Remove orphan words ===\n");
  let totalRemoved = 0;

  for (const level of LEVELS) {
    const regularPath = resolve(DB_DIR, `${level}.json`);
    const extendedPath = resolve(DB_DIR, `${level}-extended.json`);

    const regularFile = readJSON<VocabFile>(regularPath);
    let extendedFile: VocabFile = { words: [] };
    let hasExtended = false;
    try {
      extendedFile = readJSON<VocabFile>(extendedPath);
      hasExtended = true;
    } catch { /* no extended file */ }

    const allWords = [...regularFile.words, ...extendedFile.words];

    // Collect all segment texts used in examples
    const usedTerms = new Set<string>();
    for (const word of allWords) {
      for (const example of word.examples) {
        if (!example.segments) continue;
        for (const seg of example.segments) {
          if (seg.transliteration) usedTerms.add(seg.text);
        }
      }
    }

    // Remove orphans from regular file
    const regBefore = regularFile.words.length;
    regularFile.words = regularFile.words.filter((w) => usedTerms.has(w.term));
    const regRemoved = regBefore - regularFile.words.length;

    // Remove orphans from extended file
    let extRemoved = 0;
    if (hasExtended) {
      const extBefore = extendedFile.words.length;
      extendedFile.words = extendedFile.words.filter((w) => usedTerms.has(w.term));
      extRemoved = extBefore - extendedFile.words.length;
    }

    const levelRemoved = regRemoved + extRemoved;
    if (levelRemoved > 0) {
      writeJSON(regularPath, regularFile);
      if (hasExtended) writeJSON(extendedPath, extendedFile);
      console.log(`  ${level}: removed ${levelRemoved} orphans (regular: ${regRemoved}, extended: ${extRemoved})`);
    }
    totalRemoved += levelRemoved;
  }

  console.log(`\nTotal orphans removed: ${totalRemoved}`);
  return totalRemoved;
}

// ── Phase 2: Add missing segment words via LLM ──────────────────────

interface MissingTermInfo {
  term: string;
  transliteration: string;
  exampleSentence: string;
  exampleTranslation: string;
  exampleSegments: { text: string; transliteration?: string }[];
}

function collectMissingTerms(level: string): MissingTermInfo[] {
  const regularPath = resolve(DB_DIR, `${level}.json`);
  const extendedPath = resolve(DB_DIR, `${level}-extended.json`);

  const regularFile = readJSON<VocabFile>(regularPath);
  let extendedFile: VocabFile = { words: [] };
  try {
    extendedFile = readJSON<VocabFile>(extendedPath);
  } catch { /* no extended file */ }

  const allWords = [...regularFile.words, ...extendedFile.words];
  const knownTerms = new Set(allWords.map((w) => w.term));

  const missing = new Map<string, MissingTermInfo>();

  for (const word of allWords) {
    for (const example of word.examples) {
      if (!example.segments) continue;
      for (const seg of example.segments) {
        if (!seg.transliteration) continue;
        if (knownTerms.has(seg.text)) continue;
        if (missing.has(seg.text)) continue;

        missing.set(seg.text, {
          term: seg.text,
          transliteration: seg.transliteration,
          exampleSentence: example.sentence,
          exampleTranslation: example.translation,
          exampleSegments: example.segments,
        });
      }
    }
  }

  return Array.from(missing.values());
}

async function generateMissingWords(
  terms: MissingTermInfo[],
  level: string,
  wordIndex: WordIndex,
): Promise<number> {
  if (terms.length === 0) return 0;

  const extFilename = `${level}-extended.json`;
  const extPath = resolve(DB_DIR, extFilename);
  let extFile: VocabFile;
  try {
    extFile = readJSON<VocabFile>(extPath);
  } catch {
    extFile = { language: "chinese", words: [] };
  }

  const topicsList = TOPICS.join(", ");
  let generated = 0;

  const batches = chunk(terms, 20);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    console.log(`    ${level} batch ${bi + 1}/${batches.length} (${batch.length} terms)`);

    const systemPrompt = `You are a Chinese vocabulary expert. Generate vocabulary entries for Chinese words. Return a JSON object with a "words" key containing an array of word objects.`;
    const wordsList = batch.map((t) => `${t.term} (${t.transliteration})`).join(", ");
    const userPrompt = `Generate vocabulary entries for these Chinese words (level: ${level}-extended).

Each word object must have:
- "term": the Chinese word
- "transliteration": pinyin with tone marks
- "definition": {"Japanese": "...", "English": "...", "Korean": "..."}
- "grammaticalCategory": one of "noun", "verb", "adjective", "adverb", "numeral", "measure word", "conjunction", "preposition", "particle", "pronoun", "interjection", "phrase"
- "topics": array of 1-3 topics from: ${topicsList}
- "notes": brief usage note or empty string

Do NOT include "examples" — examples will be added separately.

Words: ${wordsList}`;

    let retries = 0;
    while (retries < 3) {
      try {
        const raw = await callLLM(systemPrompt, userPrompt);
        const parsed = JSON.parse(stripMarkdownFences(raw));
        const words: unknown[] = parsed.words ?? [];

        for (const w of words) {
          const wObj = w as Record<string, unknown>;
          // Add placeholder examples so validateWord passes
          if (!wObj.examples) wObj.examples = [{ sentence: "", translation: "" }];

          if (!validateWord(w)) {
            console.warn(`      Skipped invalid:`, (w as Record<string, unknown>)?.term ?? w);
            continue;
          }

          const validated = w as Omit<Word, "id" | "level">;
          const termInfo = batch.find((t) => t.term === validated.term);
          if (!termInfo) continue;

          // Check not already added (e.g. from a previous batch)
          if (extFile.words.some((ew) => ew.term === validated.term)) continue;

          const id = formatId(wordIndex.next_id);
          wordIndex.next_id++;

          const fullWord: Word = {
            ...validated,
            id,
            level: `${level}-extended`,
            topics: validated.topics as Topic[],
            examples: [
              {
                sentence: termInfo.exampleSentence,
                translation: termInfo.exampleTranslation,
                segments: termInfo.exampleSegments,
              },
            ],
          };

          extFile.words.push(fullWord);

          wordIndex.terms[validated.term] = {
            term: validated.term,
            id,
            level: `${level}-extended`,
            transliteration: validated.transliteration ?? termInfo.transliteration,
          };

          generated++;
        }
        break;
      } catch (e) {
        retries++;
        if (retries >= 3) console.error(`      Batch ${bi + 1} failed after 3 retries:`, e);
        else {
          console.warn(`      Batch ${bi + 1} retry ${retries}...`);
          await delay(2000);
        }
      }
    }

    // Save after each batch (crash-safe)
    writeJSON(extPath, extFile);
    writeJSON(resolve(DB_DIR, "word_index.json"), wordIndex);

    await delay(1000);
  }

  return generated;
}

async function addMissingSegments(): Promise<number> {
  console.log("\n=== Phase 2: Add missing segment words via LLM ===\n");

  const wordIndex = readJSON<WordIndex>(resolve(DB_DIR, "word_index.json"));
  let totalGenerated = 0;

  for (const level of LEVELS) {
    const missing = collectMissingTerms(level);
    if (missing.length === 0) {
      console.log(`  ${level}: no missing segments`);
      continue;
    }
    console.log(`  ${level}: ${missing.length} missing segments to generate`);
    const generated = await generateMissingWords(missing, level, wordIndex);
    console.log(`  ${level}: generated ${generated} words`);
    totalGenerated += generated;
  }

  console.log(`\nTotal words generated: ${totalGenerated}`);
  return totalGenerated;
}

// ── Phase 4: Add word IDs to segments ────────────────────────────────

function assignSegmentIds(): number {
  console.log("\n=== Phase 4: Add word IDs to segments ===\n");

  const wordIndex = readJSON<WordIndex>(resolve(DB_DIR, "word_index.json"));
  let assigned = 0;
  let unresolved = 0;

  const allFiles = [
    ...LEVELS.map((l) => `${l}.json`),
    ...LEVELS.map((l) => `${l}-extended.json`),
  ];

  for (const filename of allFiles) {
    const filePath = resolve(DB_DIR, filename);
    let vocab: VocabFile;
    try {
      vocab = readJSON<VocabFile>(filePath);
    } catch {
      continue;
    }

    let fileAssigned = 0;
    for (const word of vocab.words) {
      for (const example of word.examples) {
        if (!example.segments) continue;
        for (const seg of example.segments) {
          if (!seg.transliteration) continue; // skip punctuation
          const entry = wordIndex.terms[seg.text];
          if (entry) {
            (seg as Record<string, unknown>).id = entry.id;
            fileAssigned++;
          } else {
            unresolved++;
          }
        }
      }
    }

    writeJSON(filePath, vocab);
    assigned += fileAssigned;
    if (fileAssigned > 0) {
      console.log(`  ${filename}: assigned ${fileAssigned} segment IDs`);
    }
  }

  if (unresolved > 0) {
    console.log(`\n  Warning: ${unresolved} segments could not be resolved to a word ID`);
  }
  console.log(`\nTotal segment IDs assigned: ${assigned}`);
  return assigned;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const assignOnly = process.argv.includes("--assign-ids");

  if (assignOnly) {
    // Phase 4 only (run after rebuild-index)
    assignSegmentIds();
  } else {
    // Phase 1 + 2
    removeOrphans();
    await addMissingSegments();

    // Phase 3: rebuild word index
    console.log("\n=== Phase 3: Rebuild word index ===\n");
    execSync("npx tsx scripts/rebuild-word-index.ts", {
      cwd: resolve(__dirname, ".."),
      stdio: "inherit",
    });

    // Phase 4: assign segment IDs using fresh index
    assignSegmentIds();
  }

  console.log("\nDone!");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
