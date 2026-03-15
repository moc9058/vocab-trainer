/**
 * LLM-based pinyin segmentation for all example sentences.
 *
 * 1. For each HSK JSON file, batch 10 sentences per LLM call
 * 2. LLM segments each sentence into Chinese words with pinyin
 * 3. Overwrites any existing `segments` field
 * 4. Dedup pass: scan word_index for terms in multiple files, keep canonical, delete others
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { chunk, delay, segmentBatch } from "../src/llm.js";
import type { VocabFile, WordIndexEntry, Example } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = resolve(__dirname, "../DB");

// ── helpers ──────────────────────────────────────────────────────────

const HSK_FILES = [
  "HSK1.json",
  "HSK2.json",
  "HSK3.json",
  "HSK4.json",
  "HSK5.json",
  "HSK6.json",
  "HSK7-9.json",
  "HSK1-extended.json",
  "HSK2-extended.json",
  "HSK3-extended.json",
  "HSK4-extended.json",
  "HSK5-extended.json",
  "HSK6-extended.json",
  "HSK7-9-extended.json",
];

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

/** Look up a term in word_index.json → read the word from its HSK file */
function searchWord(term: string, wordIndex: WordIndex): { word: unknown; level: string } | null {
  const entry = wordIndex.terms[term];
  if (!entry) return null;
  const filePath = resolve(DB, `${entry.level}.json`);
  if (!existsSync(filePath)) return null;
  const vocab = readJSON<VocabFile>(filePath);
  const word = vocab.words.find((w) => w.term === term);
  if (!word) return null;
  return { word, level: entry.level };
}

/** Remove a word from its HSK file and from word_index.json */
function deleteWord(term: string, wordIndex: WordIndex): boolean {
  const entry = wordIndex.terms[term];
  if (!entry) return false;
  const filePath = resolve(DB, `${entry.level}.json`);
  if (!existsSync(filePath)) return false;
  const vocab = readJSON<VocabFile>(filePath);
  const idx = vocab.words.findIndex((w) => w.term === term);
  if (idx === -1) return false;
  vocab.words.splice(idx, 1);
  writeJSON(filePath, vocab);
  delete wordIndex.terms[term];
  return true;
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Loading files...");

  interface FileData {
    filename: string;
    vocab: VocabFile;
  }

  const files: FileData[] = [];
  for (const filename of HSK_FILES) {
    const path = resolve(DB, filename);
    try {
      const vocab = readJSON<VocabFile>(path);
      if (vocab.words && vocab.words.length > 0) {
        files.push({ filename, vocab });
      } else {
        console.log(`Skipping ${filename} (empty)`);
      }
    } catch {
      console.log(`Skipping ${filename} (not found)`);
    }
  }

  // Collect all sentences with references back to their example objects
  interface SentenceRef {
    example: Example;
    sentence: string;
  }

  let totalSentences = 0;
  const allRefs: SentenceRef[] = [];

  for (const { vocab } of files) {
    for (const word of vocab.words) {
      for (const ex of word.examples) {
        allRefs.push({ example: ex, sentence: ex.sentence });
        totalSentences++;
      }
    }
  }

  console.log(`Found ${totalSentences} sentences across ${files.length} files`);

  // Process in batches of 10 sentences
  const BATCH_SIZE = 10;
  const batches = chunk(allRefs, BATCH_SIZE);
  console.log(`Will make ${batches.length} LLM calls (${BATCH_SIZE} sentences per batch)`);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const sentences = batch.map((r) => r.sentence);

    if ((i + 1) % 50 === 0 || i === 0) {
      console.log(`  Batch ${i + 1}/${batches.length} (${processed}/${totalSentences} done)`);
    }

    let retries = 0;
    while (retries < 3) {
      try {
        const results = await segmentBatch(sentences);

        for (let j = 0; j < batch.length; j++) {
          const segs = results.get(j);
          if (segs) {
            (batch[j].example as Record<string, unknown>).segments = segs;
            processed++;
          } else {
            // LLM didn't return this index — keep existing segments if any
            failed++;
          }
        }
        break;
      } catch (err) {
        retries++;
        if (retries >= 3) {
          console.error(`  Batch ${i + 1} failed after 3 retries:`, err);
          failed += batch.length;
        } else {
          console.warn(`  Batch ${i + 1} retry ${retries}...`);
          await delay(2000);
        }
      }
    }

    // Rate limit
    if (i < batches.length - 1) await delay(500);

    // Save progress every 100 batches
    if ((i + 1) % 100 === 0) {
      for (const { filename, vocab } of files) {
        writeJSON(resolve(DB, filename), vocab);
      }
      console.log(`  Checkpoint saved at batch ${i + 1}`);
    }
  }

  // Final save
  for (const { filename, vocab } of files) {
    writeJSON(resolve(DB, filename), vocab);
    console.log(`Wrote ${filename}`);
  }

  console.log(`\nSegmented ${processed} sentences (${failed} failed)`);

  // ── Dedup pass ──────────────────────────────────────────────────────
  console.log("\nRunning dedup pass...");
  const indexPath = resolve(DB, "word_index.json");
  const wordIndex = readJSON<WordIndex>(indexPath);

  // Build a map of term → list of files it appears in
  const termFiles = new Map<string, { filename: string; level: string }[]>();

  for (const filename of HSK_FILES) {
    const path = resolve(DB, filename);
    if (!existsSync(path)) continue;
    let vocab: VocabFile;
    try {
      vocab = readJSON<VocabFile>(path);
    } catch {
      continue;
    }

    const level = filename.replace(".json", "");
    for (const word of vocab.words) {
      const list = termFiles.get(word.term) ?? [];
      list.push({ filename, level });
      termFiles.set(word.term, list);
    }
  }

  // Find duplicates and keep only the canonical one (word_index entry)
  let dedupCount = 0;
  for (const [term, locations] of termFiles) {
    if (locations.length <= 1) continue;

    const canonical = wordIndex.terms[term]?.level;
    if (!canonical) continue;

    for (const loc of locations) {
      if (loc.level === canonical) continue;

      // Remove from non-canonical file
      const filePath = resolve(DB, loc.filename);
      const vocab = readJSON<VocabFile>(filePath);
      const idx = vocab.words.findIndex((w) => w.term === term);
      if (idx !== -1) {
        vocab.words.splice(idx, 1);
        writeJSON(filePath, vocab);
        dedupCount++;
        console.log(`  Removed duplicate "${term}" from ${loc.filename} (canonical: ${canonical})`);
      }
    }
  }

  // Save updated word index
  writeJSON(indexPath, wordIndex);
  console.log(`Dedup removed ${dedupCount} duplicate entries`);
  console.log("Done!");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
