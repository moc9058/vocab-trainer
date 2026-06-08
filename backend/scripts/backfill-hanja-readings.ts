/**
 * One-off migration: backfill hanjaReadings for existing words in Firestore.
 *
 * For each word, the LLM (MINI model) decomposes every character into:
 *   - simplifiedChar  : the original simplified Chinese character
 *   - traditionalChar : the traditional (번체) Korean hanja form
 *   - hunEum          : list of Korean 훈음 readings (e.g. ["사랑 애"])
 *
 * Characters with no established Korean hanja reading (digits, Latin letters,
 * extremely rare characters) are returned with hunEum: [] and excluded from the
 * stored array. If ALL characters lack a reading the word gets hanjaReadings: []
 * (empty array, not absent) so it won't be reprocessed on subsequent runs.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-hanja-readings.ts [options]
 *
 * Options:
 *   --dry-run            Don't write to Firestore — just log what would change.
 *   --language=<name>    Only process words in this language (default: chinese).
 *   --limit=<n>          Process at most n words.
 *   --force              Re-process words that already have hanjaReadings set.
 *   --empty-only         Re-process only words whose hanjaReadings is an empty array.
 */

import { Firestore } from "@google-cloud/firestore";
import { callLLMWithSchema, stripMarkdownFences } from "../src/llm.js";
import type { HanjaReading } from "../src/types.js";

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const wordsCol = db.collection("words");

// ---------- CLI args ----------

interface CliArgs {
  dryRun: boolean;
  language: string;
  limit: number | null;
  force: boolean;
  emptyOnly: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { dryRun: false, language: "chinese", limit: null, force: false, emptyOnly: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--empty-only") args.emptyOnly = true;
    else if (arg.startsWith("--language=")) args.language = arg.slice("--language=".length);
    else if (arg.startsWith("--limit=")) args.limit = parseInt(arg.slice("--limit=".length), 10) || null;
    else console.warn(`Unknown argument: ${arg}`);
  }
  return args;
}

// ---------- LLM ----------

const SYSTEM_PROMPT = `You are a Korean hanja expert. Given a Chinese word (simplified characters) and its pinyin, decompose each character of the term into its Korean hanja information.

For each character provide:
- simplifiedChar : the original simplified Chinese character (copy exactly from input)
- traditionalChar: the traditional (번체) Korean hanja form; if identical to simplified, repeat it
- hunEum         : list of ALL valid Korean 훈음 readings for this character
                   (e.g. ["사랑 애"] or ["다닐 행", "항렬 항", "줄 행"] for multi-reading characters)

Rules:
- List every attested 훈음 — do NOT omit secondary readings.
- If a character has no established Korean hanja reading (digits, Latin letters, punctuation, or extremely rare characters not used in Korean), return hunEum as an empty array [].
- Do NOT fabricate readings. Only include attested 훈음.
- Process ONLY the characters in the "term" field, one entry per character, in order.`;

const LLM_SCHEMA = {
  name: "hanja_readings",
  strict: false,
  schema: {
    type: "object",
    required: ["readings"],
    properties: {
      readings: {
        type: "array",
        items: {
          type: "object",
          required: ["simplifiedChar", "traditionalChar", "hunEum"],
          properties: {
            simplifiedChar:  { type: "string" },
            traditionalChar: { type: "string" },
            hunEum:          { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
} as const;

interface LLMReading {
  simplifiedChar: string;
  traditionalChar: string;
  hunEum: string[];
}

interface LLMResponse {
  readings: LLMReading[];
}

async function fetchHanjaReadings(term: string, transliteration: string | undefined): Promise<HanjaReading[]> {
  const userPrompt = JSON.stringify({ term, pinyin: transliteration ?? "" });
  const raw = await callLLMWithSchema(
    SYSTEM_PROMPT,
    userPrompt,
    LLM_SCHEMA as unknown as Record<string, unknown>,
    "scripts/backfill-hanja-readings",
  );
  const parsed = JSON.parse(stripMarkdownFences(raw)) as LLMResponse;

  // Keep only entries that have at least one 훈음
  return parsed.readings
    .filter((r) => Array.isArray(r.hunEum) && r.hunEum.length > 0)
    .map((r) => ({
      simplifiedChar:  r.simplifiedChar,
      traditionalChar: r.traditionalChar,
      hunEum:          r.hunEum,
    }));
}

// ---------- Main ----------

async function main(): Promise<void> {
  const args = parseArgs();
  console.log("Backfill hanja readings");
  console.log(`  language: ${args.language}`);
  console.log(`  dry-run:  ${args.dryRun}`);
  console.log(`  limit:    ${args.limit ?? "<none>"}`);
  console.log(`  force:    ${args.force}`);
  console.log(`  empty-only: ${args.emptyOnly}`);

  console.log("\nFetching words...");
  const snap = await wordsCol.where("language", "==", args.language).get();
  console.log(`Found ${snap.size} word(s) in language=${args.language}`);

  let scanned = 0;
  let skipped = 0;
  let processed = 0;
  let updated = 0;
  let withoutReadings = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    if (args.limit !== null && processed >= args.limit) break;
    scanned++;

    const data = doc.data();
    const term: string = data.term ?? "";
    const transliteration: string | undefined = data.transliteration;

    // Skip if already processed (hanjaReadings field present) unless --force
    const alreadySet = Array.isArray(data.hanjaReadings);
    if (args.emptyOnly && (!alreadySet || data.hanjaReadings.length > 0)) {
      skipped++;
      continue;
    }
    if (alreadySet && !args.force && !args.emptyOnly) {
      skipped++;
      continue;
    }

    processed++;
    console.log(`\n[${scanned}] ${doc.id} "${term}"`);

    if (args.dryRun) {
      console.log(`    (dry-run) would call LLM for "${term}"`);
      continue;
    }

    try {
      const readings = await fetchHanjaReadings(term, transliteration);
      console.log(`    → ${readings.length} reading(s):`);
      for (const r of readings) {
        console.log(`       ${r.simplifiedChar} / ${r.traditionalChar}: [${r.hunEum.join(", ")}]`);
      }

      // Store even if empty (marks word as processed)
      await wordsCol.doc(doc.id).update({ hanjaReadings: readings });
      updated++;
      if (readings.length === 0) withoutReadings++;
      console.log(`    OK: saved hanjaReadings (${readings.length} entries)`);
    } catch (err) {
      failed++;
      console.error(`    FAIL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n--- Done ---");
  console.log(`Scanned:   ${scanned}`);
  console.log(`Skipped:   ${skipped} (already had hanjaReadings)`);
  console.log(`Processed: ${processed}`);
  console.log(`Updated:   ${updated}`);
  console.log(`No Hanja:  ${withoutReadings}`);
  console.log(`Failed:    ${failed}`);
  if (args.dryRun) console.log("(dry-run — no Firestore writes were made)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
