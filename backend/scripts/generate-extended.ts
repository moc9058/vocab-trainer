/**
 * Generate extended vocabulary from example sentences in HSK files.
 *
 * For each level, processes sentences in batches of 30:
 *   1. Segment batch via LLM → word/pinyin pairs, store on examples
 *   2. Classify extracted terms (move vs generate)
 *   3. Move existing words from other files to this level's extended file
 *   4. Generate new word entries via LLM
 *   5. Save after each batch for crash resilience
 * After all levels: rebuild sequential IDs and word_index.json
 *
 * Usage:
 *   cd backend && npm run generate-extended
 *   cd backend && npm run generate-extended -- HSK1 HSK3
 *   cd backend && npm run generate-extended -- hsk1 hsk7~9
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { TOPICS, type Word, type Topic } from "../src/types.js";
import {
  callLLM,
  stripMarkdownFences,
  validateWord,
  PARTICLES,
  chunk,
  delay,
  segmentBatch,
  type Segment,
} from "../src/llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "../DB/word");

const LEVELS = ["HSK1", "HSK2", "HSK3", "HSK4", "HSK5", "HSK6", "HSK7-9"];

const FILE_ORDER = [
  "HSK1.json", "HSK1-extended.json",
  "HSK2.json", "HSK2-extended.json",
  "HSK3.json", "HSK3-extended.json",
  "HSK4.json", "HSK4-extended.json",
  "HSK5.json", "HSK5-extended.json",
  "HSK6.json", "HSK6-extended.json",
  "HSK7-9.json", "HSK7-9-extended.json",
];

interface WordIndex {
  next_id: number;
  terms: Record<string, { term: string; id: string; level: string; transliteration: string }>;
}

interface TermInfo {
  term: string;
  transliteration: string;
  firstSeenLevel: string;
  firstSeenSentence: string;
  firstSeenTranslation: string;
  firstSeenSegments: Segment[];
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

// ── Move words from other files to target extended file ──────────────

function moveWords(
  terms: TermInfo[],
  allFiles: Map<string, { words: Word[] }>,
  termToFile: Map<string, string>,
): number {
  let moved = 0;

  for (const info of terms) {
    const sourceFilename = termToFile.get(info.term);
    if (!sourceFilename) continue;

    const targetFilename = `${info.firstSeenLevel}-extended.json`;

    // Don't move if already in the right place
    if (sourceFilename === targetFilename) continue;
    if (sourceFilename === `${info.firstSeenLevel}.json`) continue;

    const sourceData = allFiles.get(sourceFilename)!;
    const idx = sourceData.words.findIndex((w) => w.term === info.term);
    if (idx === -1) continue;

    const word = sourceData.words[idx];
    const movedWord: Word = { ...word, level: `${info.firstSeenLevel}-extended` };

    // Remove from source
    sourceData.words.splice(idx, 1);

    // Add to target
    const targetData = allFiles.get(targetFilename)!;
    targetData.words.push(movedWord);

    // Update lookup
    termToFile.set(info.term, targetFilename);

    console.log(`    Moved "${info.term}" from ${sourceFilename} → ${targetFilename}`);
    moved++;
  }

  return moved;
}

// ── Generate new word entries via LLM ────────────────────────────────

async function generateWords(
  terms: TermInfo[],
  level: string,
  allFiles: Map<string, { words: Word[] }>,
  wordIndex: WordIndex,
  allKnownTerms: Set<string>,
  termToFile: Map<string, string>,
): Promise<number> {
  if (terms.length === 0) return 0;

  const extFilename = `${level}-extended.json`;
  const extData = allFiles.get(extFilename)!;
  const topicsList = TOPICS.join(", ");
  let generated = 0;

  const batches = chunk(terms, 20);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    console.log(`    Generation batch ${bi + 1}/${batches.length} (${batch.length} terms)`);

    const systemPrompt = `You are a Chinese vocabulary expert. Generate vocabulary entries for Chinese words. Return a JSON object with a "words" key containing an array of word objects.`;
    const wordsList = batch.map((t) => t.term).join(", ");
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
          if (!wObj.examples) wObj.examples = [{ sentence: "", translation: "" }];

          if (!validateWord(w)) {
            console.warn(`    Skipped invalid word:`, (w as Record<string, unknown>)?.term ?? w);
            continue;
          }

          const validated = w as Omit<Word, "id" | "level">;
          if (allKnownTerms.has(validated.term)) continue;

          const termInfo = batch.find((t) => t.term === validated.term);
          if (!termInfo) continue;

          const id = formatId(wordIndex.next_id);
          wordIndex.next_id++;

          const fullWord: Word = {
            ...validated,
            id,
            level: `${level}-extended`,
            topics: validated.topics as Topic[],
            examples: [
              {
                sentence: termInfo.firstSeenSentence,
                translation: termInfo.firstSeenTranslation,
                segments: termInfo.firstSeenSegments,
              },
            ],
          };

          extData.words.push(fullWord);
          allKnownTerms.add(validated.term);
          termToFile.set(validated.term, extFilename);

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
        if (retries >= 3) console.error(`    Generation batch ${bi + 1} failed after 3 retries:`, e);
        else await delay(2000);
      }
    }

    // Save after each generation batch
    writeJSON(resolve(DB_DIR, extFilename), extData);
    writeJSON(resolve(DB_DIR, "word_index.json"), wordIndex);

    await delay(1000);
  }

  return generated;
}

// ── Process a single level (per-batch pipeline) ──────────────────────

async function processLevel(
  level: string,
  allFiles: Map<string, { words: Word[] }>,
  wordIndex: WordIndex,
  allKnownTerms: Set<string>,
  termToFile: Map<string, string>,
): Promise<void> {
  console.log(`\n=== Processing ${level} ===`);

  for (const suffix of ["", "-extended"]) {
    const filename = `${level}${suffix}.json`;
    const data = allFiles.get(filename);
    if (!data || data.words.length === 0) continue;

    // Collect example sentence references
    const exRefs: { word: Word; exIndex: number; sentence: string; translation: string }[] = [];
    for (const w of data.words) {
      for (let ei = 0; ei < w.examples.length; ei++) {
        exRefs.push({
          word: w,
          exIndex: ei,
          sentence: w.examples[ei].sentence,
          translation: w.examples[ei].translation,
        });
      }
    }

    if (exRefs.length === 0) continue;
    console.log(`  ${filename}: ${exRefs.length} sentences`);

    // Process in batches of 30
    const batches = chunk(exRefs, 30);
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      console.log(`  Batch ${bi + 1}/${batches.length} (${batch.length} sentences)`);

      // Step 1: Segment
      let batchNewTerms: TermInfo[] = [];
      let retries = 0;
      while (retries < 3) {
        try {
          const sentences = batch.map((r) => r.sentence);
          const results = await segmentBatch(sentences);

          for (let j = 0; j < batch.length; j++) {
            const segs = results.get(j);
            if (!segs) continue;

            // Store segments on the example
            const ref = batch[j];
            (ref.word.examples[ref.exIndex] as unknown as Record<string, unknown>).segments = segs;

            // Collect new terms from this batch
            for (const seg of segs) {
              if (!seg.transliteration || seg.text.length <= 1 || PARTICLES.has(seg.text)) continue;
              if (allKnownTerms.has(seg.text)) continue;

              // Avoid duplicates within this batch
              if (batchNewTerms.some((t) => t.term === seg.text)) continue;

              batchNewTerms.push({
                term: seg.text,
                transliteration: seg.transliteration,
                firstSeenLevel: level,
                firstSeenSentence: ref.sentence,
                firstSeenTranslation: ref.translation,
                firstSeenSegments: segs,
              });
            }
          }
          break;
        } catch (e) {
          retries++;
          if (retries >= 3) {
            console.error(`  Segmentation batch ${bi + 1} failed after 3 retries:`, e);
          } else {
            await delay(2000);
          }
        }
      }

      // Save segments
      writeJSON(resolve(DB_DIR, filename), data);

      if (batchNewTerms.length === 0) {
        await delay(1000);
        continue;
      }

      // Step 2: Classify — split into move vs generate
      const toMove: TermInfo[] = [];
      const toGenerate: TermInfo[] = [];

      for (const info of batchNewTerms) {
        if (termToFile.has(info.term)) {
          toMove.push(info);
        } else {
          toGenerate.push(info);
        }
      }

      console.log(`    New terms: ${batchNewTerms.length} (${toMove.length} move, ${toGenerate.length} generate)`);

      // Step 3: Move existing words
      if (toMove.length > 0) {
        const moved = moveWords(toMove, allFiles, termToFile);
        if (moved > 0) {
          // Save affected files
          for (const info of toMove) {
            const srcFile = termToFile.get(info.term);
            if (srcFile) writeJSON(resolve(DB_DIR, srcFile), allFiles.get(srcFile)!);
          }
          const extFilename = `${level}-extended.json`;
          writeJSON(resolve(DB_DIR, extFilename), allFiles.get(extFilename)!);
        }
      }

      // Mark moved terms as known
      for (const info of toMove) {
        allKnownTerms.add(info.term);
      }

      // Step 4: Generate new words
      if (toGenerate.length > 0) {
        await generateWords(toGenerate, level, allFiles, wordIndex, allKnownTerms, termToFile);
      }

      await delay(1000);
    }
  }
}

// ── Rebuild IDs ──────────────────────────────────────────────────────

function rebuildIds(
  allFiles: Map<string, { words: Word[] }>,
): WordIndex {
  let nextId = 1;
  const wordIndex: WordIndex = { next_id: 0, terms: {} };

  for (const filename of FILE_ORDER) {
    const data = allFiles.get(filename);
    if (!data) continue;

    for (const word of data.words) {
      const newId = formatId(nextId);
      word.id = newId;

      wordIndex.terms[word.term] = {
        term: word.term,
        id: newId,
        level: word.level ?? "",
        transliteration: word.transliteration ?? "",
      };

      nextId++;
    }
  }

  wordIndex.next_id = nextId;
  return wordIndex;
}

// ── Main ─────────────────────────────────────────────────────────────

/** Normalize a CLI level argument to canonical form (e.g. "hsk1" → "HSK1", "hsk789" → "HSK7-9") */
function normalizeLevel(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[~\-]/g, "");
  if (/^HSK[789]+$/.test(s)) return "HSK7-9";
  const m = s.match(/^HSK([1-6])$/);
  if (m) return `HSK${m[1]}`;
  return null;
}

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);

  let levelsToProcess: string[];
  if (cliArgs.length > 0) {
    const resolved = new Set<string>();
    const invalid: string[] = [];
    for (const arg of cliArgs) {
      const level = normalizeLevel(arg);
      if (level) resolved.add(level);
      else invalid.push(arg);
    }
    if (invalid.length > 0) {
      console.error(`Invalid level(s): ${invalid.join(", ")}. Valid: HSK1-HSK6, HSK7-9 (accepts hsk7, hsk789, hsk7~9, etc.)`);
      process.exit(1);
    }
    levelsToProcess = LEVELS.filter((l) => resolved.has(l));
  } else {
    levelsToProcess = LEVELS;
  }

  // Load all files
  const allFiles = new Map<string, { words: Word[] }>();
  for (const filename of FILE_ORDER) {
    const filepath = resolve(DB_DIR, filename);
    if (existsSync(filepath)) {
      allFiles.set(filename, readJSON(filepath));
    } else {
      allFiles.set(filename, { words: [] });
    }
  }

  const indexPath = resolve(DB_DIR, "word_index.json");
  const wordIndex = readJSON<WordIndex>(indexPath);
  console.log(`Loaded ${allFiles.size} files, word_index: ${Object.keys(wordIndex.terms).length} entries`);

  // Build lookup structures
  const allKnownTerms = new Set<string>();
  const termToFile = new Map<string, string>();
  for (const [filename, data] of allFiles) {
    for (const w of data.words) {
      allKnownTerms.add(w.term);
      termToFile.set(w.term, filename);
    }
  }

  // Process each level (per-batch pipeline)
  for (const level of levelsToProcess) {
    await processLevel(level, allFiles, wordIndex, allKnownTerms, termToFile);
  }

  // Final pass: rebuild IDs
  console.log("\n=== Rebuilding IDs ===");
  const newIndex = rebuildIds(allFiles);

  for (const filename of FILE_ORDER) {
    const data = allFiles.get(filename);
    if (data) writeJSON(resolve(DB_DIR, filename), data);
  }
  writeJSON(indexPath, newIndex);

  const totalWords = newIndex.next_id - 1;
  console.log(`word_index.json: ${Object.keys(newIndex.terms).length} entries, next_id: ${newIndex.next_id}`);
  console.log(`Total words: ${totalWords}`);
  console.log("\nDone!");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
