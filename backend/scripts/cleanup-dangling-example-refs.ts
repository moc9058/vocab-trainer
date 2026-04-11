/**
 * Remove dangling example references from words.
 *
 * A dangling reference is an entry in `words.exampleIds` or
 * `words.appearsInIds` pointing at an example sentence doc that no longer
 * exists. These occur when a shared/deduped example is deleted via its
 * original owner, and the other words that held it in their own arrays
 * are never cleaned up.
 *
 * This script:
 *   1. Loads every example sentence for the target language into a set.
 *   2. Walks every word for the target language.
 *   3. For each word, computes the dangling entries and rewrites
 *      `exampleIds` / `appearsInIds` with only the live references.
 *
 * Safe to re-run. Use `--dry-run` to preview.
 *
 * Usage:
 *   cd backend && npx tsx scripts/cleanup-dangling-example-refs.ts [--language=chinese] [--dry-run]
 */

import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.find((a) => a.startsWith("--language="));
const language = langArg ? langArg.split("=")[1] : "chinese";

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

async function main() {
  console.log(
    `Cleaning dangling example refs for language "${language}"${dryRun ? " (DRY RUN)" : ""}...\n`,
  );

  const [exSnap, wordSnap] = await Promise.all([
    db.collection("example_sentences").where("language", "==", language).get(),
    db.collection("words").where("language", "==", language).get(),
  ]);

  const liveExIds = new Set(exSnap.docs.map((d) => d.id));
  console.log(`Found ${liveExIds.size} live example sentences.`);
  console.log(`Found ${wordSnap.size} words.\n`);

  let updatedCount = 0;
  let removedFromExampleIds = 0;
  let removedFromAppearsInIds = 0;
  const preview: string[] = [];

  for (const doc of wordSnap.docs) {
    const d = doc.data();
    const exampleIds = Array.isArray(d.exampleIds) ? (d.exampleIds as string[]) : null;
    const appearsInIds = Array.isArray(d.appearsInIds) ? (d.appearsInIds as string[]) : null;

    const update: Record<string, unknown> = {};

    if (exampleIds) {
      const keep = exampleIds.filter((id) => liveExIds.has(id));
      if (keep.length !== exampleIds.length) {
        update.exampleIds = keep;
        removedFromExampleIds += exampleIds.length - keep.length;
      }
    }
    if (appearsInIds) {
      const keep = appearsInIds.filter((id) => liveExIds.has(id));
      if (keep.length !== appearsInIds.length) {
        update.appearsInIds = keep;
        removedFromAppearsInIds += appearsInIds.length - keep.length;
      }
    }

    if (Object.keys(update).length === 0) continue;

    updatedCount++;
    if (preview.length < 10) {
      const parts: string[] = [];
      if (update.exampleIds !== undefined) {
        parts.push(
          `exampleIds ${exampleIds!.length}->${(update.exampleIds as string[]).length}`,
        );
      }
      if (update.appearsInIds !== undefined) {
        parts.push(
          `appearsInIds ${appearsInIds!.length}->${(update.appearsInIds as string[]).length}`,
        );
      }
      preview.push(`  ${doc.id} (${d.term}): ${parts.join(", ")}`);
    }

    if (!dryRun) {
      await doc.ref.update(update);
    }
  }

  console.log(
    `${updatedCount} word(s) ${dryRun ? "would be" : "were"} updated: ` +
      `-${removedFromExampleIds} from exampleIds, -${removedFromAppearsInIds} from appearsInIds.`,
  );
  if (preview.length > 0) {
    console.log("\nPreview:");
    for (const p of preview) console.log(p);
  }
}

main().catch((e) => {
  console.error("Cleanup failed:", e);
  process.exit(1);
});
