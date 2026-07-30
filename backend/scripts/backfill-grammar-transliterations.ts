/**
 * One-off migration: backfill `transliteration` (statement pinyin) on existing
 * Chinese grammar items in Firestore.
 *
 * Only the manual grammar form ever had an input for this field, so every item
 * created through a queue-driven path — the article importer above all, which is
 * what feeds Group B — was stored with no reading, and the quiz answer-reveal had
 * nothing to show. `routes/grammar.ts` now generates it at smart-add time; this
 * script covers everything already in the database.
 *
 * Items are sent to the LLM in CHUNKS (default 20 per call): a statement is a
 * short pattern with no cross-item context, so one call per item would spend a
 * whole round-trip and a whole prompt on each of ~100 items for nothing.
 *
 * An item counts as needing a reading when `transliteration` is absent, blank, OR
 * byte-identical to `statement` — that last case is a real state in the data
 * (「v+得+程度副詞+adj」 stored as its own transliteration), and it renders as the
 * prompt printed twice rather than as a reading.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-grammar-transliterations.ts [options]
 *
 * Options:
 *   --dry-run            Don't write to Firestore — just log what would change.
 *   --language=<name>    Only process this language (default: chinese).
 *   --category=B         Only items belonging to a category-B (Group B) grammar group.
 *   --limit=<n>          Process at most n items.
 *   --chunk=<n>          Items per LLM call (default 20).
 *   --force              Re-generate for items that already have a transliteration.
 */

// Must stay the FIRST import: it fixes the project for every Firestore client the
// process builds, including the one src/firestore.ts creates at module load.
import { PROJECT_ID, DATABASE_ID } from "./_project-env.js";
import { Firestore } from "@google-cloud/firestore";
import { fillGrammarTransliteration, splitStatementForReading } from "../src/llm.js";

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  ignoreUndefinedProperties: true,
});

const grammarCol = db.collection("grammar_items");
const grammarGroupsCol = db.collection("grammar_groups");

// ---------- CLI args ----------

interface CliArgs {
  dryRun: boolean;
  language: string;
  category: string | null;
  limit: number | null;
  chunk: number;
  force: boolean;
}

/** Items per LLM call. Big enough to amortise the prompt, small enough that one
 *  bad response costs a handful of items rather than the whole run. */
const DEFAULT_CHUNK = 20;

function parseArgs(): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    language: "chinese",
    category: null,
    limit: null,
    chunk: DEFAULT_CHUNK,
    force: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg.startsWith("--language=")) args.language = arg.slice("--language=".length);
    else if (arg.startsWith("--category=")) args.category = arg.slice("--category=".length);
    else if (arg.startsWith("--limit=")) args.limit = parseInt(arg.slice("--limit=".length), 10) || null;
    else if (arg.startsWith("--chunk=")) args.chunk = parseInt(arg.slice("--chunk=".length), 10) || DEFAULT_CHUNK;
    else console.warn(`Unknown argument: ${arg}`);
  }
  return args;
}

/**
 * Does this reading still line up with its statement?
 *
 * Everything that is not a romanization candidate — placeholders, connectors,
 * spacing, Japanese labels — must survive in order. A reading that fails this
 * has lost part of the pattern (「s+被/让/叫+行為者+v+結果補語」 stored as just
 * "bèi/ràng/jiào") and is as unusable as a missing one. Hand-typed legacy values
 * and output from the earlier whole-string generator both land here; the current
 * generator cannot produce one, since it reassembles the fixed pieces in code.
 */
function readingFitsStatement(statement: string, reading: string): boolean {
  let cursor = 0;
  for (const piece of splitStatementForReading(statement).filter((p) => !p.candidate)) {
    const at = reading.indexOf(piece.text, cursor);
    if (at === -1) return false;
    cursor = at + piece.text.length;
  }
  return true;
}

/** Grammar IDs held by groups of the given meta-category (absent category = "A"). */
async function idsInCategory(language: string, category: string): Promise<Set<string>> {
  const snap = await grammarGroupsCol.where("language", "==", language).get();
  const ids = new Set<string>();
  for (const doc of snap.docs) {
    const data = doc.data();
    if ((data.category ?? "A") !== category) continue;
    for (const id of (data.grammarIds ?? []) as string[]) ids.add(id);
  }
  return ids;
}

// ---------- Main ----------

async function main(): Promise<void> {
  const args = parseArgs();
  console.log("Backfill grammar statement pinyin");
  console.log(`  language: ${args.language}`);
  console.log(`  category: ${args.category ?? "<all>"}`);
  console.log(`  dry-run:  ${args.dryRun}`);
  console.log(`  limit:    ${args.limit ?? "<none>"}`);
  console.log(`  chunk:    ${args.chunk} item(s) per LLM call`);
  console.log(`  force:    ${args.force}`);
  // Printed because writing to the wrong project is the costly mistake here.
  console.log(`  project:  ${PROJECT_ID}`);
  console.log(`  database: ${DATABASE_ID}`);

  if (args.language !== "chinese") {
    console.warn(
      `\nWARNING: transliteration is a Chinese-only field; "${args.language}" will almost ` +
        `certainly produce nothing useful.`
    );
  }

  console.log("\nFetching grammar items...");
  let snap;
  try {
    snap = await grammarCol.where("language", "==", args.language).get();
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
  console.log(`Found ${snap.size} grammar item(s) in language=${args.language}`);

  const scopeIds = args.category ? await idsInCategory(args.language, args.category) : null;
  if (scopeIds) {
    console.log(`Category ${args.category} covers ${scopeIds.size} grammar item(s)`);
  }

  // ---- select the work ----
  let skipped = 0;
  let outOfScope = 0;
  const todo: { id: string; statement: string; previous?: string }[] = [];
  for (const doc of snap.docs) {
    if (args.limit !== null && todo.length >= args.limit) break;
    const data = doc.data();
    if (scopeIds && !scopeIds.has(doc.id)) {
      outOfScope++;
      continue;
    }
    const statement: string = (data.statement ?? "").trim();
    if (!statement) {
      skipped++;
      continue;
    }
    const current: string = (data.transliteration ?? "").trim();
    // An echo of the statement is not a reading, and neither is one that has
    // lost pieces of the pattern — both are treated as missing.
    const hasReading =
      current.length > 0 &&
      current !== statement &&
      readingFitsStatement(statement, current);
    if (hasReading && !args.force) {
      skipped++;
      continue;
    }
    todo.push({ id: doc.id, statement, previous: current || undefined });
  }

  const chunkCount = Math.ceil(todo.length / args.chunk);
  console.log(
    `Out of scope: ${outOfScope}; skipping ${skipped} already-readable item(s); ` +
      `${todo.length} to do in ${chunkCount} call(s) of up to ${args.chunk}`
  );

  let updated = 0;
  let failed = 0;

  for (let start = 0; start < todo.length; start += args.chunk) {
    const chunk = todo.slice(start, start + args.chunk);
    const n = Math.floor(start / args.chunk) + 1;
    console.log(`\n[chunk ${n}/${chunkCount}] ${chunk.length} item(s)`);

    if (args.dryRun) {
      for (const it of chunk) {
        console.log(`    (dry-run) ${it.statement}${it.previous ? `  [was: ${it.previous}]` : ""}`);
      }
      continue;
    }

    let byIndex: Map<number, string>;
    try {
      byIndex = await fillGrammarTransliteration(chunk.map((it) => it.statement));
    } catch (err) {
      // One bad response costs this chunk only; the rest of the run continues and
      // the items stay unprocessed, so a later run picks them up.
      failed += chunk.length;
      console.error(`    FAIL (whole chunk): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Writes are batched too — one commit per LLM call instead of one per item.
    const batch = db.batch();
    let inBatch = 0;
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      const value = byIndex.get(i);
      if (!value) {
        // Nothing romanizable (a pattern of pure placeholders) or the model
        // skipped it. Left unset rather than stamped with a useless echo.
        failed++;
        console.error(`    NO READING: "${item.statement}" (left unchanged)`);
        continue;
      }
      console.log(`    ${item.statement}  →  ${value}`);
      batch.update(grammarCol.doc(item.id), { transliteration: value });
      inBatch++;
      updated++;
    }
    if (inBatch > 0) await batch.commit();
    console.log(`    saved ${inBatch} item(s)`);
  }

  console.log("\n--- Done ---");
  console.log(`Skipped:    ${skipped} (already had a reading)`);
  console.log(`Out of scope: ${outOfScope}`);
  console.log(`Processed:  ${todo.length}`);
  console.log(`LLM calls:  ${args.dryRun ? 0 : chunkCount}`);
  console.log(`Updated:    ${updated}`);
  console.log(`No reading: ${failed}`);
  if (args.dryRun) console.log("(dry-run — no Firestore writes were made)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
