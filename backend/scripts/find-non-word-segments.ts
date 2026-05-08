/**
 * Find (and optionally fix) example sentences that contain non-word segments.
 *
 * A segment is considered non-word if its text contains no CJK characters and
 * no Latin letters — i.e. it is punctuation, whitespace, numbers, or symbols.
 *
 * Usage:
 *   cd backend && npx tsx scripts/find-non-word-segments.ts [--language=chinese] [--limit=<n>] [--fix]
 *
 * Modes:
 *   (default)  Report mode — prints violations and exits 1 if any found
 *   --fix      Strip non-word segments from affected docs in Firestore (no LLM call)
 *
 * Default language: chinese
 */

import "dotenv/config";
import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const langArg = args.find((a) => a.startsWith("--language="));
const language = langArg ? langArg.split("=")[1] : "chinese";
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const fix = args.includes("--fix");

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const exampleSentences = db.collection("example_sentences");

interface Segment {
  text: string;
  transliteration?: string;
  id?: string;
}

/** True if the segment text is a word (contains at least one CJK or Latin letter). */
function isWordSegment(text: string): boolean {
  return /[a-zA-Z一-鿿㐀-䶿豈-﫿]/u.test(text);
}

async function run() {
  const mode = fix ? "FIX" : "REPORT";
  console.log(`Finding non-word segments for language "${language}" [${mode}]...\n`);

  const snap = await exampleSentences.where("language", "==", language).get();
  console.log(`Scanned ${snap.size} example sentences.\n`);

  interface Violation {
    id: string;
    sentence: string;
    badSegments: string[];
    cleanedSegments: Segment[];
  }

  const violations: Violation[] = [];
  let scanned = 0;

  for (const doc of snap.docs) {
    if (scanned >= limit) break;
    scanned++;

    const d = doc.data();
    const segs = d.segments as Segment[] | undefined;
    if (!Array.isArray(segs) || segs.length === 0) continue;

    const bad = segs.filter((s) => !isWordSegment(s.text));
    if (bad.length === 0) continue;

    violations.push({
      id: doc.id,
      sentence: d.sentence as string,
      badSegments: bad.map((s) => s.text),
      cleanedSegments: segs.filter((s) => isWordSegment(s.text)),
    });
  }

  if (violations.length === 0) {
    console.log("No non-word segments found.");
    process.exit(0);
  }

  console.log(`Found ${violations.length} sentence(s) with non-word segments:\n`);
  for (const v of violations) {
    console.log(`  [${v.id}] ${v.sentence}`);
    console.log(`    Non-word segments: ${v.badSegments.map((s) => JSON.stringify(s)).join(", ")}`);
  }

  if (!fix) {
    console.log(`\nRe-run with --fix to strip these segments in-place.`);
    process.exit(1);
  }

  // Fix mode: strip non-word segments in Firestore
  console.log(`\nStripping non-word segments from ${violations.length} doc(s)...`);
  const BATCH_LIMIT = 500;
  let batch = db.batch();
  let batchCount = 0;

  for (const v of violations) {
    batch.update(exampleSentences.doc(v.id), { segments: v.cleanedSegments });
    batchCount++;
    if (batchCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) await batch.commit();

  console.log(`Done. Cleaned ${violations.length} sentence(s).`);
}

run().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
