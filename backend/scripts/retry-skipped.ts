/**
 * 1. Remove orphan words (globally unused as segments)
 * 2. Generate missing segment words (cross-level lookup)
 * 3. Rebuild index + assign segment IDs
 *
 * Usage: npx tsx scripts/retry-skipped.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  callLLM,
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

interface TermContext {
  term: string;
  transliteration: string;
  exampleSentence: string;
  exampleTranslation: string;
  exampleSegments: { text: string; transliteration?: string }[];
  firstSeenLevel: string; // level where the segment was found
}

const topicsSet = new Set<string>(TOPICS);

async function main(): Promise<void> {
  // ── Load all files ──
  const allFiles = new Map<string, VocabFile>();
  for (const level of LEVELS) {
    for (const suffix of ["", "-extended"]) {
      const filename = `${level}${suffix}.json`;
      try {
        allFiles.set(filename, readJSON<VocabFile>(resolve(DB_DIR, filename)));
      } catch { /* skip */ }
    }
  }

  // ── Build global known terms ──
  const globalKnownTerms = new Set<string>();
  for (const [, vocab] of allFiles) {
    for (const word of vocab.words) globalKnownTerms.add(word.term);
  }

  // ── Build global used terms (all segment texts) ──
  const globalUsedTerms = new Set<string>();
  for (const [, vocab] of allFiles) {
    for (const word of vocab.words) {
      for (const example of word.examples) {
        if (!example.segments) continue;
        for (const seg of example.segments) {
          if (seg.transliteration) globalUsedTerms.add(seg.text);
        }
      }
    }
  }

  // ── Step 1: Remove orphans (words never used as segments globally) ──
  console.log("=== Step 1: Remove orphans ===\n");
  let orphansRemoved = 0;
  for (const [filename, vocab] of allFiles) {
    const before = vocab.words.length;
    vocab.words = vocab.words.filter((w) => globalUsedTerms.has(w.term));
    const removed = before - vocab.words.length;
    if (removed > 0) {
      writeJSON(resolve(DB_DIR, filename), vocab);
      console.log(`  ${filename}: removed ${removed} orphans`);
      orphansRemoved += removed;
    }
  }
  console.log(`Total orphans removed: ${orphansRemoved}`);

  // Update globalKnownTerms after orphan removal
  globalKnownTerms.clear();
  for (const [, vocab] of allFiles) {
    for (const word of vocab.words) globalKnownTerms.add(word.term);
  }

  // ── Step 2: Find missing segment terms (cross-level) ──
  console.log("\n=== Step 2: Generate missing segment words ===\n");

  const missingContexts = new Map<string, TermContext>();

  for (const level of LEVELS) {
    for (const suffix of ["", "-extended"]) {
      const filename = `${level}${suffix}.json`;
      const vocab = allFiles.get(filename);
      if (!vocab) continue;

      for (const word of vocab.words) {
        for (const example of word.examples) {
          if (!example.segments) continue;
          for (const seg of example.segments) {
            if (!seg.transliteration) continue;
            if (globalKnownTerms.has(seg.text)) continue;
            if (missingContexts.has(seg.text)) continue;

            missingContexts.set(seg.text, {
              term: seg.text,
              transliteration: seg.transliteration,
              exampleSentence: example.sentence,
              exampleTranslation: example.translation,
              exampleSegments: example.segments,
              firstSeenLevel: level,
            });
          }
        }
      }
    }
  }

  console.log(`Found ${missingContexts.size} missing terms`);
  if (missingContexts.size === 0) {
    console.log("Nothing to generate.");
  } else {
    const wordIndex = readJSON<WordIndex>(resolve(DB_DIR, "word_index.json"));

    // Group by level
    const byLevel = new Map<string, TermContext[]>();
    for (const ctx of missingContexts.values()) {
      const list = byLevel.get(ctx.firstSeenLevel) ?? [];
      list.push(ctx);
      byLevel.set(ctx.firstSeenLevel, list);
    }

    let totalGenerated = 0;

    for (const [level, contexts] of byLevel) {
      console.log(`\n  ${level}: ${contexts.length} terms`);

      const extFilename = `${level}-extended.json`;
      const extPath = resolve(DB_DIR, extFilename);
      let extFile = allFiles.get(extFilename);
      if (!extFile) {
        extFile = { language: "chinese", words: [] };
        allFiles.set(extFilename, extFile);
      }

      const batches = chunk(contexts, 20);
      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        const topicsList = TOPICS.join(", ");
        const wordsList = batch.map((t) => `${t.term} (${t.transliteration})`).join(", ");

        const systemPrompt = `You are a Chinese vocabulary expert. Generate vocabulary entries for Chinese words. Return a JSON object with a "words" key containing an array of word objects.

IMPORTANT: Every word MUST have a valid "topics" array with 1-3 topics from the allowed list. Every word MUST have all three definitions (Japanese, English, Korean).`;

        const userPrompt = `Generate vocabulary entries for these Chinese words (level: ${level}-extended).

Each word object must have:
- "term": the Chinese word (MUST match exactly)
- "transliteration": pinyin with tone marks
- "definition": {"Japanese": "...", "English": "...", "Korean": "..."} (ALL THREE required)
- "grammaticalCategory": one of "noun", "verb", "adjective", "adverb", "numeral", "measure word", "conjunction", "preposition", "particle", "pronoun", "interjection", "phrase"
- "topics": array of 1-3 topics from: ${topicsList}
- "notes": brief usage note or empty string

Do NOT include "examples".

Words: ${wordsList}`;

        let retries = 0;
        while (retries < 3) {
          try {
            const raw = await callLLM(systemPrompt, userPrompt);
            const parsed = JSON.parse(stripMarkdownFences(raw));
            const words: unknown[] = parsed.words ?? [];

            for (const w of words) {
              const wObj = w as Record<string, unknown>;
              const termStr = wObj.term as string;
              if (!termStr) continue;

              const ctx = batch.find((c) => c.term === termStr);
              if (!ctx) continue;
              if (extFile!.words.some((ew) => ew.term === termStr)) continue;

              // Relaxed validation with fallbacks
              if (!wObj.examples) wObj.examples = [{ sentence: "", translation: "" }];
              if (!Array.isArray(wObj.topics) || (wObj.topics as string[]).filter((t) => topicsSet.has(t)).length === 0) {
                wObj.topics = ["Language Fundamentals"];
              } else {
                wObj.topics = (wObj.topics as string[]).filter((t) => topicsSet.has(t));
              }
              if (!wObj.definition || typeof wObj.definition !== "object") {
                wObj.definition = { Japanese: termStr, English: termStr, Korean: termStr };
              }
              const def = wObj.definition as Record<string, string>;
              if (!def.Japanese) def.Japanese = termStr;
              if (!def.English) def.English = termStr;
              if (!def.Korean) def.Korean = termStr;
              if (typeof wObj.transliteration !== "string" || !wObj.transliteration) {
                wObj.transliteration = ctx.transliteration;
              }
              if (typeof wObj.grammaticalCategory !== "string" || !wObj.grammaticalCategory) {
                wObj.grammaticalCategory = "phrase";
              }

              const id = formatId(wordIndex.next_id);
              wordIndex.next_id++;

              const fullWord: Word = {
                term: termStr,
                transliteration: (wObj.transliteration as string) ?? ctx.transliteration,
                definition: wObj.definition as Record<string, string>,
                grammaticalCategory: wObj.grammaticalCategory as string,
                topics: wObj.topics as Topic[],
                notes: (wObj.notes as string) ?? "",
                examples: [
                  {
                    sentence: ctx.exampleSentence,
                    translation: ctx.exampleTranslation,
                    segments: ctx.exampleSegments,
                  },
                ],
                id,
                level: `${level}-extended`,
              };

              extFile!.words.push(fullWord);
              wordIndex.terms[termStr] = {
                term: termStr,
                id,
                level: `${level}-extended`,
                transliteration: fullWord.transliteration ?? ctx.transliteration,
              };

              console.log(`    Added "${termStr}"`);
              totalGenerated++;
            }
            break;
          } catch (e) {
            retries++;
            if (retries >= 3) console.error(`    Batch failed after 3 retries:`, e);
            else {
              console.warn(`    Retry ${retries}...`);
              await delay(2000);
            }
          }
        }

        writeJSON(extPath, extFile!);
        writeJSON(resolve(DB_DIR, "word_index.json"), wordIndex);
        if (bi < batches.length - 1) await delay(1000);
      }
    }

    console.log(`\nTotal generated: ${totalGenerated}`);
  }

  // ── Step 3: Rebuild index ──
  console.log("\n=== Step 3: Rebuild word index ===\n");
  execSync("npx tsx scripts/rebuild-word-index.ts", {
    cwd: resolve(__dirname, ".."),
    stdio: "inherit",
  });

  // ── Step 4: Assign segment IDs ──
  console.log("\n=== Step 4: Assign segment IDs ===\n");
  execSync("npx tsx scripts/fill-missing-and-cleanup.ts --assign-ids", {
    cwd: resolve(__dirname, ".."),
    stdio: "inherit",
  });

  console.log("\nDone!");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
