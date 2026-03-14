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
} from "../src/llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "../DB");

const LEVELS = ["HSK1", "HSK2", "HSK3", "HSK4", "HSK5", "HSK6", "HSK7-9"];
const MAX_ROUNDS = 5;

interface WordIndex {
  next_id: number;
  terms: Record<string, { term: string; id: string; level: string; pinyin: string }>;
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

async function extractTerms(sentences: string[]): Promise<string[]> {
  const allTerms: string[] = [];
  const batches = chunk(sentences, 50);

  for (let i = 0; i < batches.length; i++) {
    console.log(`  Extraction batch ${i + 1}/${batches.length} (${batches[i].length} sentences)`);
    const systemPrompt = `You are a Chinese language expert. Segment Chinese sentences into individual words. Return a JSON object with a "words" key containing an array of distinct Chinese word strings. Exclude grammatical particles (的/了/着/过/吗/呢/吧/啊/呀), punctuation, and single characters that are not standalone words.`;
    const userPrompt = `Extract all distinct Chinese words from these sentences:\n\n${batches[i].map((s, j) => `${j + 1}. ${s}`).join("\n")}`;

    let retries = 0;
    while (retries < 2) {
      try {
        const raw = await callLLM(systemPrompt, userPrompt);
        const parsed = JSON.parse(stripMarkdownFences(raw));
        const words: string[] = parsed.words ?? parsed.terms ?? [];
        allTerms.push(...words);
        break;
      } catch (e) {
        retries++;
        if (retries >= 2) console.error(`  Extraction batch ${i + 1} failed after retries:`, e);
      }
    }
    await delay(1000);
  }

  return [...new Set(allTerms)];
}

function collectSentences(words: Word[]): string[] {
  const sentences: string[] = [];
  for (const w of words) {
    for (const ex of w.examples) {
      sentences.push(ex.sentence);
    }
  }
  return sentences;
}

async function processLevel(level: string, wordIndex: WordIndex, knownTerms: Set<string>, indexPath: string): Promise<void> {
  console.log(`\n=== Processing ${level} ===`);

  const corePath = resolve(DB_DIR, `${level}.json`);
  const extPath = resolve(DB_DIR, `${level}-extended.json`);

  if (!existsSync(corePath)) {
    console.log(`  ${level}.json not found, skipping`);
    return;
  }

  const coreFile = readJSON<{ words: Word[] }>(corePath);
  const extFile = existsSync(extPath) ? readJSON<{ words: Word[] }>(extPath) : { words: [] };

  // Build level-scoped terms set (only this level's core + extended words)
  const levelTerms = new Set<string>();
  for (const w of coreFile.words) {
    levelTerms.add(w.term);
  }
  for (const w of extFile.words) {
    levelTerms.add(w.term);
    knownTerms.add(w.term); // Also add to global dedup set
  }

  const extendedLevel = `${level}-extended`;
  const allNewWords: Word[] = [...extFile.words];
  let currentWords = coreFile.words;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(`\n  --- Round ${round + 1}/${MAX_ROUNDS} ---`);

    // Collect example sentences from current words
    const sentences = collectSentences(currentWords);
    if (sentences.length === 0) {
      console.log("  No sentences to process, stopping");
      break;
    }
    console.log(`  Extracting terms from ${sentences.length} sentences`);

    // Extract terms from sentences
    const extractedTerms = await extractTerms(sentences);

    // Filter against level-scoped terms (not global knownTerms) and particles
    const newTerms = extractedTerms.filter(
      (t) => !levelTerms.has(t) && !PARTICLES.has(t) && t.length > 0
    );

    // Split into moved terms (exist in another level's core) and truly new terms
    const movedTerms: string[] = [];
    const trulyNewTerms: string[] = [];
    for (const t of newTerms) {
      if (wordIndex.terms[t]) {
        movedTerms.push(t);
      } else {
        trulyNewTerms.push(t);
      }
    }

    console.log(`  Found ${extractedTerms.length} terms, ${newTerms.length} are new (${movedTerms.length} moved, ${trulyNewTerms.length} truly new)`);

    if (movedTerms.length + trulyNewTerms.length < 3) {
      console.log("  Too few new terms (<3), stopping");
      break;
    }

    // Move cross-level terms: copy from source level's core file into this extended file
    for (const t of movedTerms) {
      const sourceEntry = wordIndex.terms[t];
      // Skip if already in an extended file (don't move between extended files)
      if (sourceEntry.level.includes("-extended")) continue;
      // Skip if already handled by global dedup
      if (knownTerms.has(t)) continue;

      const sourceCorePath = resolve(DB_DIR, `${sourceEntry.level}.json`);
      if (!existsSync(sourceCorePath)) continue;

      const sourceFile = readJSON<{ words: Word[] }>(sourceCorePath);
      const wordIdx = sourceFile.words.findIndex((w) => w.term === t);
      if (wordIdx === -1) continue;

      const movedWord: Word = {
        ...sourceFile.words[wordIdx],
        level: extendedLevel,
      };

      // Remove from source file
      sourceFile.words.splice(wordIdx, 1);
      writeJSON(sourceCorePath, sourceFile);

      // Add to extended
      allNewWords.push(movedWord);
      knownTerms.add(t);
      levelTerms.add(t);

      // Update word index
      wordIndex.terms[t].level = extendedLevel;
    }

    if (movedTerms.length > 0) {
      writeJSON(extPath, { words: allNewWords });
      writeJSON(indexPath, wordIndex);
      console.log(`  Moved ${movedTerms.length} terms from other levels`);
    }

    // Generate full word entries for truly new terms in batches of 20
    const batches = chunk(trulyNewTerms, 20);
    const topicsList = TOPICS.join(", ");
    const roundWords: Word[] = [];

    for (let i = 0; i < batches.length; i++) {
      console.log(`  Generation batch ${i + 1}/${batches.length} (${batches[i].length} terms)`);
      const systemPrompt = `You are a Chinese vocabulary expert. Generate detailed vocabulary entries for Chinese words. Return a JSON object with a "words" key containing an array of word objects.`;
      const userPrompt = `Generate vocabulary entries for these Chinese words (level: ${extendedLevel}).

Each word object must have:
- "term": the Chinese word
- "transliteration": pinyin with tone marks
- "definition": {"Japanese": "...", "English": "...", "Korean": "..."}
- "grammaticalCategory": one of "noun", "verb", "adjective", "adverb", "numeral", "measure word", "conjunction", "preposition", "particle", "pronoun", "interjection", "phrase"
- "examples": [{"sentence": "Chinese sentence using the word", "translation": "Japanese translation"}] (1-2 examples)
- "topics": array of 1-3 topics from: ${topicsList}
- "notes": brief usage note or empty string

Words: ${batches[i].join(", ")}`;

      let retries = 0;
      while (retries < 2) {
        try {
          const raw = await callLLM(systemPrompt, userPrompt);
          const parsed = JSON.parse(stripMarkdownFences(raw));
          const words: unknown[] = parsed.words ?? [];
          for (const w of words) {
            if (validateWord(w)) {
              const validated = w as Omit<Word, "id" | "level">;
              if (knownTerms.has(validated.term)) continue;

              const id = formatId(wordIndex.next_id);
              wordIndex.next_id++;

              const fullWord: Word = {
                ...validated,
                id,
                level: extendedLevel,
                topics: validated.topics as Topic[],
              };

              roundWords.push(fullWord);
              allNewWords.push(fullWord);
              knownTerms.add(validated.term);

              wordIndex.terms[validated.term] = {
                term: validated.term,
                id,
                level: extendedLevel,
                pinyin: validated.transliteration ?? "",
              };
            } else {
              console.warn(`  Skipped invalid word:`, (w as Record<string, unknown>)?.term ?? w);
            }
          }
          break;
        } catch (e) {
          retries++;
          if (retries >= 2) console.error(`  Generation batch ${i + 1} failed after retries:`, e);
        }
      }

      // Write after each batch for crash resilience
      writeJSON(extPath, { words: allNewWords });
      writeJSON(indexPath, wordIndex);
      console.log(`  Saved ${allNewWords.length} words to ${level}-extended.json after batch ${i + 1}`);

      await delay(1000);
    }

    console.log(`  Added ${roundWords.length} words this round (total: ${allNewWords.length})`);

    // Use the newly generated words as input for the next round
    currentWords = roundWords;
  }
}

async function main(): Promise<void> {
  const cliLevel = process.argv[2];
  const levelsToProcess = cliLevel ? [cliLevel] : LEVELS;

  // Validate CLI level
  if (cliLevel && !LEVELS.includes(cliLevel)) {
    console.error(`Invalid level: ${cliLevel}. Valid levels: ${LEVELS.join(", ")}`);
    process.exit(1);
  }

  console.log("Loading word index...");
  const indexPath = resolve(DB_DIR, "word_index.json");
  const wordIndex = readJSON<WordIndex>(indexPath);

  // Known terms set — used only for cross-level dedup during generation.
  // NOT pre-populated from word_index; each level builds its own levelTerms set.
  const knownTerms = new Set<string>();
  console.log(`Word index loaded (${Object.keys(wordIndex.terms).length} entries, next_id: ${wordIndex.next_id})`);

  // Process levels sequentially
  for (const level of levelsToProcess) {
    await processLevel(level, wordIndex, knownTerms, indexPath);

    // Save word index after each level
    writeJSON(indexPath, wordIndex);
    console.log(`  Updated word_index.json (next_id: ${wordIndex.next_id})`);
  }

  console.log("\nDone!");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
