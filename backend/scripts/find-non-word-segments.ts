/**
 * Find (and optionally fix) example sentences that contain dirty segments.
 *
 * A segment is considered dirty if its text is not composed entirely of word
 * characters (CJK ideographs or Latin letters). This catches:
 *   - Pure punctuation:  "，"
 *   - Mixed content:     "，所以"  (punctuation fused with a word)
 *   - Numbers, spaces, symbols, etc.
 *
 * Usage:
 *   cd backend && npx tsx scripts/find-non-word-segments.ts [--language=chinese] [--limit=<n>] [--fix]
 *
 * Modes:
 *   (default)  Report mode — prints violations and exits 1 if any found
 *   --fix      Drop dirty segments from affected docs in Firestore (no LLM call)
 *
 * Default language: chinese
 */

// Must stay the FIRST import: it fixes the project for every Firestore client the
// process builds — without it the client resolves to gcloud's default project,
// which has no `vocab-database`, and every query dies with a bare `5 NOT_FOUND`.
import { PROJECT_ID, DATABASE_ID } from "./_project-env.js";
import "dotenv/config";
import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const langArg = args.find((a) => a.startsWith("--language="));
const language = langArg ? langArg.split("=")[1] : "chinese";
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const fix = args.includes("--fix");

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  ignoreUndefinedProperties: true,
});

const exampleSentences = db.collection("example_sentences");

interface Segment {
  text: string;
  transliteration?: string;
  id?: string;
}

// Matches a string composed entirely of CJK ideographs or Latin letters.
// Any other character (punctuation, numbers, spaces, symbols) causes a miss.
const CLEAN_SEGMENT_RE = /^[\p{Script=Han}a-zA-Z]+$/u;

function isCleanSegment(text: string): boolean {
  return CLEAN_SEGMENT_RE.test(text);
}

async function run() {
  const mode = fix ? "FIX" : "REPORT";
  console.log(`Finding dirty segments for language "${language}" [${mode}]...\n`);

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

    const bad = segs.filter((s) => !isCleanSegment(s.text));
    if (bad.length === 0) continue;

    violations.push({
      id: doc.id,
      sentence: d.sentence as string,
      badSegments: bad.map((s) => s.text),
      cleanedSegments: segs.flatMap((s) => {
        if (isCleanSegment(s.text)) return [s];
        const stripped = s.text.replace(/[^\p{Script=Han}a-zA-Z]/gu, "");
        return stripped.length > 0 ? [{ ...s, text: stripped }] : [];
      }),
    });
  }

  if (violations.length === 0) {
    console.log("No dirty segments found.");
    process.exit(0);
  }

  console.log(`Found ${violations.length} sentence(s) with dirty segments:\n`);
  for (const v of violations) {
    console.log(`  [${v.id}] ${v.sentence}`);
    console.log(`    Dirty: ${v.badSegments.map((s) => JSON.stringify(s)).join(", ")}`);
  }

  if (!fix) {
    console.log(`\nRe-run with --fix to drop these segments in-place.`);
    process.exit(1);
  }

  console.log(`\nDropping dirty segments from ${violations.length} doc(s)...`);
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
