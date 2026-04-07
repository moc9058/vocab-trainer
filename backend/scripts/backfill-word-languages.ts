/**
 * One-off migration: backfill missing definition + example-translation languages
 * for existing words in Firestore.
 *
 * Words are now expected to carry definitions and example translations in all four
 * supported languages (en, ja, ko, zh). Pre-existing words may only have a subset.
 * This script identifies those gaps and asks the LLM to fill them in, merging the
 * result into Firestore without overwriting any existing language entries.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-word-languages.ts [options]
 *
 * Options:
 *   --dry-run            Don't write to Firestore — just log what would change.
 *   --language=<code>    Only backfill words in this language (e.g. chinese, english).
 *   --limit=<n>          Process at most n words (useful for testing on a small batch).
 */

import { Firestore } from "@google-cloud/firestore";
import { callLLMFullWithSchema, stripMarkdownFences } from "../src/llm.js";
import type { Word, Meaning, Example } from "../src/types.js";

const ALL_LANGUAGES = ["en", "ja", "ko", "zh"] as const;
type LangCode = (typeof ALL_LANGUAGES)[number];

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const wordsCol = db.collection("words");

// ---------- CLI args ----------

interface CliArgs {
  dryRun: boolean;
  language: string | null;
  limit: number | null;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { dryRun: false, language: null, limit: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--language=")) args.language = arg.slice("--language=".length);
    else if (arg.startsWith("--limit=")) args.limit = parseInt(arg.slice("--limit=".length), 10) || null;
    else console.warn(`Unknown argument: ${arg}`);
  }
  return args;
}

// ---------- Gap detection ----------

function definitionMissingLangs(def: Meaning): LangCode[] {
  const text = def.text || {};
  return ALL_LANGUAGES.filter((l) => !text[l] || !String(text[l]).trim());
}

function exampleMissingLangs(ex: Example): LangCode[] {
  const t = ex.translation;
  if (!t) return [...ALL_LANGUAGES];
  if (typeof t === "string") {
    // Legacy single-string translation — treat as having no language entries.
    // We'll let the LLM fill all four (it will see the original string in the input).
    return [...ALL_LANGUAGES];
  }
  return ALL_LANGUAGES.filter((l) => !t[l] || !String(t[l]).trim());
}

interface WordGaps {
  defGaps: Map<number, LangCode[]>;     // definition index -> missing langs
  exGaps: Map<number, LangCode[]>;      // example index -> missing langs
}

function findGaps(word: Word): WordGaps | null {
  const defGaps = new Map<number, LangCode[]>();
  const exGaps = new Map<number, LangCode[]>();
  word.definitions.forEach((d, i) => {
    const m = definitionMissingLangs(d);
    if (m.length > 0) defGaps.set(i, m);
  });
  word.examples.forEach((e, i) => {
    const m = exampleMissingLangs(e);
    if (m.length > 0) exGaps.set(i, m);
  });
  if (defGaps.size === 0 && exGaps.size === 0) return null;
  return { defGaps, exGaps };
}

// ---------- LLM ----------

const BACKFILL_PROMPT = `You are a multilingual vocabulary expert. You will be given a JSON object describing a vocabulary word that already has some definitions and example sentences, plus a list of language entries that are missing from each definition's \`text\` object and each example's \`translation\` object.

Your task is to fill in ONLY the missing language entries. Do not change anything that already exists. Do not add or remove definitions or examples. Do not change the part of speech, the example sentences, or the segments.

Languages use ISO 639-1 codes: en (English), ja (Japanese), ko (Korean), zh (Chinese).

When filling in a definition's missing language, write the meaning of the word in that language with the same nuance as the existing definitions in other languages. When the missing language matches the source language of the word itself (for example, a Chinese definition for a Chinese word), write a concise monolingual definition in that language.

When filling in an example sentence's missing translation, write a faithful translation of the sentence into that language. If the missing language matches the language the sentence is written in, write the sentence verbatim (no translation needed).

Return a JSON object with this exact shape:
{
  "definitionsBackfill": [
    { "index": <number>, "text": { "<langCode>": "<missing entry>", ... } }
  ],
  "examplesBackfill": [
    { "index": <number>, "translation": { "<langCode>": "<missing entry>", ... } }
  ]
}

Only include the indices and language codes that were explicitly listed as missing in the input. Omit any definition or example whose missing list is empty.`;

const BACKFILL_SCHEMA = {
  name: "vocab_backfill",
  strict: false,
  schema: {
    type: "object",
    required: ["definitionsBackfill", "examplesBackfill"],
    properties: {
      definitionsBackfill: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "text"],
          properties: {
            index: { type: "integer" },
            text: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
      examplesBackfill: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "translation"],
          properties: {
            index: { type: "integer" },
            translation: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
    },
  },
} as const;

interface BackfillResponse {
  definitionsBackfill: { index: number; text: Record<string, string> }[];
  examplesBackfill: { index: number; translation: Record<string, string> }[];
}

async function backfillWord(word: Word, gaps: WordGaps): Promise<BackfillResponse> {
  const userInput = {
    language: (word as Word & { language?: string }).language ?? null,
    term: word.term,
    transliteration: word.transliteration ?? null,
    definitions: word.definitions.map((d, i) => ({
      index: i,
      partOfSpeech: d.partOfSpeech,
      existingText: d.text,
      missingLanguages: gaps.defGaps.get(i) ?? [],
    })),
    examples: word.examples.map((e, i) => ({
      index: i,
      sentence: e.sentence,
      existingTranslation: e.translation,
      missingLanguages: gaps.exGaps.get(i) ?? [],
    })),
  };

  const raw = await callLLMFullWithSchema(
    BACKFILL_PROMPT,
    JSON.stringify(userInput, null, 2),
    BACKFILL_SCHEMA as unknown as Record<string, unknown>,
    "scripts/backfill-word-languages",
  );
  return JSON.parse(stripMarkdownFences(raw)) as BackfillResponse;
}

// ---------- Merge ----------

function mergeBackfill(word: Word, result: BackfillResponse): { definitions: Meaning[]; examples: Example[] } {
  const definitions: Meaning[] = word.definitions.map((d) => ({
    partOfSpeech: d.partOfSpeech,
    text: { ...(d.text || {}) },
  }));
  for (const fill of result.definitionsBackfill) {
    const target = definitions[fill.index];
    if (!target) continue;
    for (const [lang, value] of Object.entries(fill.text)) {
      if (!target.text[lang] || !String(target.text[lang]).trim()) {
        if (value && String(value).trim()) target.text[lang] = value;
      }
    }
  }

  const examples: Example[] = word.examples.map((e) => ({
    sentence: e.sentence,
    translation: e.translation,
    ...(e.segments ? { segments: e.segments } : {}),
  }));
  for (const fill of result.examplesBackfill) {
    const target = examples[fill.index];
    if (!target) continue;
    // Convert legacy string translations into objects, preserving the original
    // under its best-guess language slot if possible — otherwise the LLM-provided
    // entries take over.
    let current: Record<string, string>;
    if (typeof target.translation === "string") {
      current = {};
    } else {
      current = { ...(target.translation || {}) };
    }
    for (const [lang, value] of Object.entries(fill.translation)) {
      if (!current[lang] || !current[lang].trim()) {
        if (value && String(value).trim()) current[lang] = value;
      }
    }
    target.translation = current;
  }

  return { definitions, examples };
}

// ---------- Main ----------

async function main(): Promise<void> {
  const args = parseArgs();
  console.log("Backfill word languages");
  console.log(`  dry-run: ${args.dryRun}`);
  console.log(`  language: ${args.language ?? "<all>"}`);
  console.log(`  limit:    ${args.limit ?? "<none>"}`);

  let query: FirebaseFirestore.Query = wordsCol;
  if (args.language) {
    query = query.where("language", "==", args.language);
  }

  console.log("\nFetching words...");
  const snap = await query.get();
  console.log(`Found ${snap.size} word(s)${args.language ? ` in language=${args.language}` : ""}`);

  let scanned = 0;
  let needBackfill = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    if (args.limit !== null && updated >= args.limit) break;
    scanned++;

    const data = doc.data();
    const word: Word = {
      id: doc.id,
      term: data.term,
      transliteration: data.transliteration,
      definitions: Array.isArray(data.definitions) ? (data.definitions as Meaning[]) : [],
      examples: Array.isArray(data.examples) ? (data.examples as Example[]) : [],
      topics: data.topics ?? [],
      level: data.level,
      notes: data.notes,
    };
    const language = (data.language as string | undefined) ?? "";

    const gaps = findGaps(word);
    if (!gaps) {
      skipped++;
      continue;
    }
    needBackfill++;

    const totalMissing =
      Array.from(gaps.defGaps.values()).reduce((a, b) => a + b.length, 0) +
      Array.from(gaps.exGaps.values()).reduce((a, b) => a + b.length, 0);

    console.log(
      `\n[${scanned}] ${doc.id} "${word.term}" (lang=${language}) — ${totalMissing} missing entries ` +
        `(${gaps.defGaps.size} definitions, ${gaps.exGaps.size} examples)`,
    );

    if (args.dryRun) {
      for (const [i, langs] of gaps.defGaps) {
        console.log(`    def[${i}]: missing ${langs.join(", ")}`);
      }
      for (const [i, langs] of gaps.exGaps) {
        console.log(`    ex[${i}]:  missing ${langs.join(", ")}`);
      }
      continue;
    }

    try {
      const llmResult = await backfillWord(word, gaps);
      const merged = mergeBackfill(word, llmResult);

      // Sanity check: each definition and example should now have all four langs.
      const stillMissing =
        merged.definitions.some((d) => definitionMissingLangs(d).length > 0) ||
        merged.examples.some((e) => exampleMissingLangs(e).length > 0);
      if (stillMissing) {
        console.warn(`    WARN: still missing some languages after merge — writing partial fill anyway`);
      }

      await wordsCol.doc(doc.id).update({
        definitions: merged.definitions,
        examples: merged.examples,
      });
      updated++;
      console.log(`    OK: filled and updated`);
    } catch (err) {
      failed++;
      console.error(`    FAIL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n--- Done ---");
  console.log(`Scanned:        ${scanned}`);
  console.log(`Already full:   ${skipped}`);
  console.log(`Need backfill:  ${needBackfill}`);
  console.log(`Updated:        ${updated}`);
  console.log(`Failed:         ${failed}`);
  if (args.dryRun) console.log("(dry-run — no Firestore writes were made)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
