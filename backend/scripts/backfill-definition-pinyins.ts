/**
 * One-off migration: backfill pinyins on each definition for existing words.
 *
 * For each word with a non-empty `transliteration`, any definition that is
 * missing `pinyins` gets `pinyins: [word.transliteration]`. Definitions that
 * already have a non-empty `pinyins` array are left untouched.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-definition-pinyins.ts [options]
 *
 * Options:
 *   --dry-run            Don't write to Firestore — just log what would change.
 *   --language=<name>    Only process words in this language (default: chinese).
 *   --limit=<n>          Process at most n words.
 */

import { Firestore } from "@google-cloud/firestore";

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const wordsCol = db.collection("words");

interface CliArgs {
  dryRun: boolean;
  language: string;
  limit: number | null;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { dryRun: false, language: "chinese", limit: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--language=")) args.language = arg.slice("--language=".length);
    else if (arg.startsWith("--limit=")) args.limit = parseInt(arg.slice("--limit=".length), 10) || null;
    else console.warn(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs();

  console.log("Backfill definition pinyins");
  console.log(`  language: ${args.language}`);
  console.log(`  dry-run:  ${args.dryRun}`);
  console.log(`  limit:    ${args.limit ?? "<none>"}`);

  console.log("\nFetching words...");
  const snap = await wordsCol.where("language", "==", args.language).get();
  console.log(`Found ${snap.size} word(s) in language=${args.language}`);

  let scanned = 0;
  let skipped = 0;
  let updated = 0;

  // Batch writes: Firestore max 500 ops per batch
  let batch = db.batch();
  let batchCount = 0;
  const BATCH_SIZE = 500;

  const flush = async () => {
    if (batchCount === 0) return;
    if (!args.dryRun) await batch.commit();
    batch = db.batch();
    batchCount = 0;
  };

  for (const doc of snap.docs) {
    if (args.limit !== null && updated >= args.limit) break;
    scanned++;

    const data = doc.data();
    const transliteration: string = data.transliteration ?? "";
    if (!transliteration) {
      skipped++;
      continue;
    }

    const definitions: any[] = Array.isArray(data.definitions) ? data.definitions : [];
    let needsUpdate = false;

    const updatedDefs = definitions.map((def) => {
      if (Array.isArray(def.pinyins) && def.pinyins.length > 0) return def;
      needsUpdate = true;
      return { ...def, pinyins: [transliteration] };
    });

    if (!needsUpdate) {
      skipped++;
      continue;
    }

    const term: string = data.term ?? doc.id;
    console.log(`  ${doc.id} "${term}" → adding pinyins: ["${transliteration}"] to ${updatedDefs.filter((d, i) => !definitions[i].pinyins?.length).length} definition(s)`);

    if (!args.dryRun) {
      batch.update(doc.ref, { definitions: updatedDefs });
      batchCount++;
      if (batchCount >= BATCH_SIZE) await flush();
    }
    updated++;
  }

  await flush();

  console.log("\n--- Done ---");
  console.log(`Scanned:  ${scanned}`);
  console.log(`Skipped:  ${skipped} (no transliteration or already had pinyins)`);
  console.log(`Updated:  ${updated}`);
  if (args.dryRun) console.log("(dry-run — no Firestore writes were made)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
