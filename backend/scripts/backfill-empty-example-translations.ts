/**
 * One-off backfill: LLM-generate translations for example_sentences docs whose
 * `translation` is empty ("", {}, all-empty values, or missing), OR is missing
 * one or more of the target definition languages for its source language (e.g.
 * a hand-typed single-language string, or a Record missing ja/ko/zh).
 *
 * These docs were created by chip adds / grammar saves before the routes gained
 * the missing-translation fallback (see src/exampleTranslations.ts), or were
 * saved with only one language filled in by a manual translation field.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-empty-example-translations.ts [options]
 *
 * Options:
 *   --dry-run          Don't call the LLM or write to Firestore — just list what would change.
 *   --language=<name>  Only process this language (default: all languages).
 *   --limit=<n>        Process at most n sentences.
 */

import { Firestore } from "@google-cloud/firestore";
import {
  needsMoreTranslations,
  generateMissingExampleTranslations,
} from "../src/exampleTranslations.js";
import type { ExampleSentence } from "../src/types.js";

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const exampleSentences = db.collection("example_sentences");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.find((a) => a.startsWith("--language="));
const language = langArg ? langArg.split("=")[1] : undefined;
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;

async function main() {
  console.log(
    `Backfilling empty example translations for ${language ? `language "${language}"` : "ALL languages"}` +
    `${limit ? `, limit ${limit}` : ""}${dryRun ? " (DRY RUN)" : ""}...\n`
  );

  const snap = language
    ? await exampleSentences.where("language", "==", language).get()
    : await exampleSentences.get();
  console.log(`Scanned ${snap.size} example sentences.`);

  // Collect empty-translation docs, grouped by language (translation target
  // languages exclude the sentence's own language).
  const byLanguage = new Map<string, { exampleId: string; sentence: string }[]>();
  let emptyCount = 0;
  for (const doc of snap.docs) {
    const d = doc.data() as ExampleSentence;
    const lang = d.language ?? "unknown";
    if (!needsMoreTranslations(d.translation, lang)) continue;
    emptyCount++;
    if (limit !== undefined && emptyCount > limit) break;
    if (!byLanguage.has(lang)) byLanguage.set(lang, []);
    byLanguage.get(lang)!.push({ exampleId: doc.id, sentence: d.sentence });
    console.log(`  [${lang}] ${doc.id}: "${d.sentence}"`);
  }

  const queued = [...byLanguage.values()].reduce((n, items) => n + items.length, 0);
  console.log(`\nEmpty translations found: ${emptyCount}${limit !== undefined && emptyCount > limit ? ` (processing first ${queued})` : ""}`);

  if (queued === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (dryRun) {
    console.log("(dry-run — no LLM calls or Firestore writes were made)");
    return;
  }

  let updated = 0;
  for (const [lang, items] of byLanguage) {
    console.log(`\nGenerating translations for ${items.length} ${lang} sentence(s)...`);
    const applied = await generateMissingExampleTranslations(lang, items, {
      log: { error: (obj, msg) => console.error(msg ?? "LLM error", obj) },
      route: "scripts/backfill-empty-example-translations",
    });
    for (const [id, trans] of applied) {
      console.log(`  ${id}: ${JSON.stringify(trans)}`);
    }
    updated += applied.size;
  }

  console.log("\n--- Done ---");
  console.log(`Queued:  ${queued}`);
  console.log(`Updated: ${updated}`);
  if (updated < queued) {
    console.log(`Failed/skipped: ${queued - updated} (re-run to retry)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
