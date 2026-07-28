/**
 * One-off migration: backfill hanjaReadings for existing words in Firestore.
 *
 * Words are sent to the LLM in CHUNKS (default 10 per call): the readings are a
 * per-character lookup with no cross-word context, so one call per word spends a
 * whole round-trip and a whole prompt on each of ~400 words for nothing.
 *
 * For each word, the LLM (FULL model) decomposes every character into:
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
 *   --chunk=<n>          Words per LLM call (default 10).
 *   --force              Re-process words that already have hanjaReadings set.
 *   --empty-only         Re-process only words whose hanjaReadings is an empty array.
 */

// Must stay the FIRST import: it fixes the project for every Firestore client the
// process builds, including the one src/firestore.ts creates at module load.
import { PROJECT_ID, DATABASE_ID } from "./_project-env.js";
import { Firestore } from "@google-cloud/firestore";
import { generateHanjaReadingsBatch } from "../src/hanja.js";
import type { HanjaReading } from "../src/types.js";

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  ignoreUndefinedProperties: true,
});

const wordsCol = db.collection("words");

// ---------- CLI args ----------

interface CliArgs {
  dryRun: boolean;
  language: string;
  limit: number | null;
  chunk: number;
  force: boolean;
  emptyOnly: boolean;
}

/** Words per LLM call. Big enough to amortise the prompt, small enough that one
 *  bad response costs a handful of words rather than the whole run. */
const DEFAULT_CHUNK = 10;

function parseArgs(): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    language: "chinese",
    limit: null,
    chunk: DEFAULT_CHUNK,
    force: false,
    emptyOnly: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--empty-only") args.emptyOnly = true;
    else if (arg.startsWith("--language=")) args.language = arg.slice("--language=".length);
    else if (arg.startsWith("--limit=")) args.limit = parseInt(arg.slice("--limit=".length), 10) || null;
    else if (arg.startsWith("--chunk=")) args.chunk = parseInt(arg.slice("--chunk=".length), 10) || DEFAULT_CHUNK;
    else console.warn(`Unknown argument: ${arg}`);
  }
  return args;
}

// ---------- Main ----------

async function main(): Promise<void> {
  const args = parseArgs();
  console.log("Backfill hanja readings");
  console.log(`  language: ${args.language}`);
  console.log(`  dry-run:  ${args.dryRun}`);
  console.log(`  limit:    ${args.limit ?? "<none>"}`);
  console.log(`  chunk:    ${args.chunk} word(s) per LLM call`);
  console.log(`  force:    ${args.force}`);
  console.log(`  empty-only: ${args.emptyOnly}`);
  // Printed because writing to the wrong project is the costly mistake here.
  console.log(`  project:  ${PROJECT_ID}`);
  console.log(`  database: ${DATABASE_ID}`);

  console.log("\nFetching words...");
  let snap;
  try {
    snap = await wordsCol.where("language", "==", args.language).get();
  } catch (err) {
    if ((err as { code?: number }).code === 5) {
      throw new Error(
        `Firestore returned NOT_FOUND: project "${PROJECT_ID}" has no database ` +
          `"${DATABASE_ID}". Check FIRESTORE_PROJECT / FIRESTORE_DATABASE_ID, and that ` +
          `the account gcloud is authenticated as can read that project.`
      );
    }
    throw err;
  }
  console.log(`Found ${snap.size} word(s) in language=${args.language}`);

  // ---- select the work ----
  let skipped = 0;
  const todo: { id: string; term: string; transliteration?: string }[] = [];
  for (const doc of snap.docs) {
    if (args.limit !== null && todo.length >= args.limit) break;
    const data = doc.data();
    const alreadySet = Array.isArray(data.hanjaReadings);
    if (args.emptyOnly && (!alreadySet || data.hanjaReadings.length > 0)) {
      skipped++;
      continue;
    }
    if (alreadySet && !args.force && !args.emptyOnly) {
      skipped++;
      continue;
    }
    const term: string = data.term ?? "";
    if (!term) {
      skipped++;
      continue;
    }
    todo.push({ id: doc.id, term, transliteration: data.transliteration });
  }

  const chunkCount = Math.ceil(todo.length / args.chunk);
  console.log(
    `Skipping ${skipped} already-processed word(s); ${todo.length} to do ` +
      `in ${chunkCount} call(s) of up to ${args.chunk}`
  );

  let updated = 0;
  let withoutReadings = 0;
  let failed = 0;

  for (let start = 0; start < todo.length; start += args.chunk) {
    const chunk = todo.slice(start, start + args.chunk);
    const n = Math.floor(start / args.chunk) + 1;
    console.log(`\n[chunk ${n}/${chunkCount}] ${chunk.map((w) => w.term).join(", ")}`);

    if (args.dryRun) {
      console.log(`    (dry-run) would call the LLM for ${chunk.length} word(s)`);
      continue;
    }

    let readingsByTerm: Map<string, HanjaReading[]>;
    try {
      readingsByTerm = await generateHanjaReadingsBatch(chunk, "scripts/backfill-hanja-readings");
    } catch (err) {
      // One bad response costs this chunk only; the rest of the run continues and
      // the words stay unprocessed, so a later run picks them up.
      failed += chunk.length;
      console.error(`    FAIL (whole chunk): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Writes are batched too — one commit per LLM call instead of one per word.
    const batch = db.batch();
    let inBatch = 0;
    for (const word of chunk) {
      const readings = readingsByTerm.get(word.term);
      if (!readings) {
        failed++;
        console.error(`    MISSING from response: "${word.term}" (left unprocessed)`);
        continue;
      }
      console.log(
        `    ${word.term}: ${readings
          .map((r) => `${r.simplifiedChar}/${r.traditionalChar}[${r.hunEum.join(", ")}]`)
          .join(" ") || "(no hanja)"}`
      );
      // Stored even when empty — that is what marks the word as processed.
      batch.update(wordsCol.doc(word.id), { hanjaReadings: readings });
      inBatch++;
      updated++;
      if (readings.length === 0) withoutReadings++;
    }
    if (inBatch > 0) await batch.commit();
    console.log(`    saved ${inBatch} word(s)`);
  }

  console.log("\n--- Done ---");
  console.log(`Skipped:   ${skipped} (already had hanjaReadings)`);
  console.log(`Processed: ${todo.length}`);
  console.log(`LLM calls: ${args.dryRun ? 0 : chunkCount}`);
  console.log(`Updated:   ${updated}`);
  console.log(`No Hanja:  ${withoutReadings}`);
  console.log(`Failed:    ${failed}`);
  if (args.dryRun) console.log("(dry-run — no Firestore writes were made)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
