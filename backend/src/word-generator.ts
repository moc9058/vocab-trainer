import {
  getAllWords,
  getPinyinMap,
  getNextWordId,
  addWord,
  batchAddPinyinEntries,
} from "./firestore.js";
import {
  callLLM,
  stripMarkdownFences,
  validateWord,
  PARTICLES,
  PARTICLE_PINYIN,
  generatePinyinForChars,
  chunk,
  delay,
} from "./llm.js";
import { TOPICS, type Word, type Topic } from "./types.js";

const MAX_NEW_TERMS = 100;
const BATCH_SIZE = 20;

// Module-level concurrency lock: one run per language at a time
const runningGenerations = new Map<string, Promise<void>>();

export function generateMissingWords(
  language: string,
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): void {
  const existing = runningGenerations.get(language);
  if (existing) {
    logger.info(`[word-generator] Already running for ${language}, skipping`);
    return;
  }

  const promise = doGenerate(language, logger).finally(() => {
    runningGenerations.delete(language);
  });
  runningGenerations.set(language, promise);
}

async function doGenerate(
  language: string,
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): Promise<void> {
  try {
    logger.info(`[word-generator] Starting generation for ${language}`);

    // 1. Collect all example sentences with their source word's level
    const allWords = await getAllWords(language);
    const sentencesWithLevel: { sentence: string; level: string }[] = [];
    for (const w of allWords) {
      for (const ex of w.examples) {
        sentencesWithLevel.push({ sentence: ex.sentence, level: w.level ?? "HSK1" });
      }
    }

    if (sentencesWithLevel.length === 0) {
      logger.info("[word-generator] No sentences found, aborting");
      return;
    }

    // 2. Build pinyin map and known terms set
    const pinyinMap = await getPinyinMap(language);
    const knownTerms = new Set(Object.keys(pinyinMap));

    // 2a. Seed particles into pinyin map and word_index
    const particleEntries: { term: string; pinyin: string }[] = [];
    for (const [term, pinyin] of Object.entries(PARTICLE_PINYIN)) {
      if (!knownTerms.has(term)) {
        particleEntries.push({ term, pinyin });
        knownTerms.add(term);
        pinyinMap[term] = pinyin;
      }
    }
    if (particleEntries.length > 0) {
      await batchAddPinyinEntries(`${language}-extended`, particleEntries);
      logger.info(`[word-generator] Seeded ${particleEntries.length} particle pinyin entries`);
    }

    let maxLen = Math.max(0, ...Object.keys(pinyinMap).map((k) => k.length));

    // 3. First segmentation pass: find missing single chars
    const punctuation = /^[\s\p{P}\p{S}\p{N}]+$/u;
    const chineseChar = /[\u4e00-\u9fff]/;
    const missingSingleChars = new Set<string>();

    const hskOrder = ["HSK1", "HSK2", "HSK3", "HSK4", "HSK5", "HSK6", "HSK7-9"];
    function hskRank(level: string): number {
      const base = level.replace(/-extended$/, "");
      const idx = hskOrder.indexOf(base);
      return idx >= 0 ? idx : hskOrder.length;
    }

    function segmentSentence(
      sentence: string,
      pMap: Record<string, string>,
      known: Set<string>,
      mLen: number
    ): { matched: string[]; unmatched: string[] } {
      const matched: string[] = [];
      const unmatched: string[] = [];
      let i = 0;
      while (i < sentence.length) {
        let found = false;
        const end = Math.min(i + mLen, sentence.length);
        // Greedy longest-match for len >= 2
        for (let len = end - i; len >= 2; len--) {
          const substr = sentence.slice(i, i + len);
          if (pMap[substr]) {
            matched.push(substr);
            i += len;
            found = true;
            break;
          }
        }
        if (found) continue;
        // Check single char
        const ch = sentence[i];
        if (pMap[ch]) {
          matched.push(ch);
        } else {
          unmatched.push(ch);
        }
        i++;
      }
      return { matched, unmatched };
    }

    // First pass: collect missing single Chinese chars
    for (const { sentence } of sentencesWithLevel) {
      const { unmatched } = segmentSentence(sentence, pinyinMap, knownTerms, maxLen);
      for (const ch of unmatched) {
        if (chineseChar.test(ch) && !knownTerms.has(ch)) {
          missingSingleChars.add(ch);
        }
      }
    }

    // 3a. Generate pinyin for missing single chars via LLM in batches of 50
    if (missingSingleChars.size > 0) {
      logger.info(`[word-generator] Found ${missingSingleChars.size} missing single chars, generating pinyin`);
      const charBatches = chunk([...missingSingleChars], 50);
      for (const batch of charBatches) {
        try {
          const results = await generatePinyinForChars(batch);
          const entries = results.map((r) => ({ term: r.char, pinyin: r.pinyin }));
          if (entries.length > 0) {
            await batchAddPinyinEntries(`${language}-extended`, entries);
            for (const { term, pinyin } of entries) {
              knownTerms.add(term);
              pinyinMap[term] = pinyin;
            }
          }
        } catch (e) {
          logger.error("[word-generator] Failed to generate pinyin for char batch:", e);
        }
      }
      maxLen = Math.max(0, ...Object.keys(pinyinMap).map((k) => k.length));
    }

    // 4. Second segmentation pass with updated map: collect multi-char missing terms
    const multiCharMissing = new Map<string, string>();

    for (const { sentence, level: sourceLevel } of sentencesWithLevel) {
      const { unmatched } = segmentSentence(sentence, pinyinMap, knownTerms, maxLen);
      // Group consecutive unmatched Chinese chars into multi-char terms
      let buf = "";
      for (const ch of unmatched) {
        if (chineseChar.test(ch)) {
          buf += ch;
        } else {
          if (buf.length > 1 && !PARTICLES.has(buf)) {
            const existing = multiCharMissing.get(buf);
            if (!existing || hskRank(sourceLevel) < hskRank(existing)) {
              multiCharMissing.set(buf, sourceLevel);
            }
          }
          buf = "";
        }
      }
      if (buf.length > 1 && !PARTICLES.has(buf)) {
        const existing = multiCharMissing.get(buf);
        if (!existing || hskRank(sourceLevel) < hskRank(existing)) {
          multiCharMissing.set(buf, sourceLevel);
        }
      }
    }

    // Filter out already-known terms
    const termsToGenerate = [...multiCharMissing.keys()]
      .filter((t) => !knownTerms.has(t))
      .slice(0, MAX_NEW_TERMS);

    if (termsToGenerate.length === 0) {
      logger.info("[word-generator] No missing multi-char terms found");
      return;
    }

    logger.info(`[word-generator] Found ${multiCharMissing.size} missing multi-char terms, generating up to ${termsToGenerate.length}`);

    // 4. Batch generate word entries via LLM
    const batches = chunk(termsToGenerate, BATCH_SIZE);
    const topicsList = TOPICS.join(", ");
    let totalAdded = 0;

    for (let i = 0; i < batches.length; i++) {
      logger.info(`[word-generator] Batch ${i + 1}/${batches.length} (${batches[i].length} terms)`);

      const systemPrompt = `You are a Chinese vocabulary expert. Generate detailed vocabulary entries for Chinese words. Return a JSON object with a "words" key containing an array of word objects.`;
      const userPrompt = `Generate vocabulary entries for these Chinese words.

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

              const sourceLevel = multiCharMissing.get(validated.term) ?? "HSK1";
              const baseLevel = sourceLevel.replace(/-extended$/, "");
              const id = await getNextWordId(language);
              const fullWord: Word = {
                ...validated,
                id,
                level: `${baseLevel}-extended`,
                topics: validated.topics as Topic[],
              };

              await addWord(`${language}-extended`, fullWord);
              knownTerms.add(validated.term);
              totalAdded++;
            }
          }
          break;
        } catch (e) {
          retries++;
          if (retries >= 2) {
            logger.error(`[word-generator] Batch ${i + 1} failed after retries:`, e);
          }
        }
      }

      if (i < batches.length - 1) {
        await delay(1000);
      }
    }

    logger.info(`[word-generator] Done. Added ${totalAdded} words for ${language}`);
  } catch (e) {
    logger.error("[word-generator] Unexpected error:", e);
  }
}
