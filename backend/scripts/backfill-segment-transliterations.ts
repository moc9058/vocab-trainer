/**
 * One-off backfill: copy word-level canonical pinyin into linked example sentence segments.
 *
 * For each example sentence, any segment that has a `seg.id` (linked to a word)
 * gets its `seg.transliteration` updated to the word's canonical pinyin, provided
 * the word is monophonic (all definitions share the same pinyin, or no pinyins
 * array is present — falls back to word.transliteration).
 *
 * Polyphonic words (e.g. 得: de / děi) are skipped so the LLM-generated
 * contextual pronunciation is preserved.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-segment-transliterations.ts [options]
 *
 * Options:
 *   --dry-run          Don't write to Firestore — just log what would change.
 *   --language=<name>  Only process this language (default: chinese).
 */

import { Firestore } from "@google-cloud/firestore";

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const exampleSentences = db.collection("example_sentences");
const wordsCol = db.collection("words");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.find((a) => a.startsWith("--language="));
const language = langArg ? langArg.split("=")[1] : "chinese";

interface WordDoc {
  id: string;
  definitions?: { pinyins?: string[] }[];
  transliteration?: string;
}

interface Segment {
  text: string;
  transliteration?: string;
  id?: string;
}

function getCanonicalPinyin(word: WordDoc): string | undefined {
  const allPinyins = new Set<string>();
  for (const def of word.definitions ?? []) {
    for (const py of def.pinyins ?? []) {
      const p = py.trim();
      if (p) allPinyins.add(p);
    }
  }
  if (allPinyins.size === 1) return [...allPinyins][0];
  if (allPinyins.size === 0) return word.transliteration;
  return undefined; // Polyphonic — keep LLM-generated contextual value
}

async function fetchWordDocs(wordIds: string[]): Promise<Map<string, WordDoc>> {
  const idToWord = new Map<string, WordDoc>();
  const CHUNK = 100;
  for (let i = 0; i < wordIds.length; i += CHUNK) {
    const chunk = wordIds.slice(i, i + CHUNK);
    const refs = chunk.map((id) => wordsCol.doc(id));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      if (doc.exists) {
        const d = doc.data()!;
        idToWord.set(doc.id, {
          id: doc.id,
          definitions: (d.definitions as { pinyins?: string[] }[] | undefined) ?? [],
          transliteration: d.transliteration as string | undefined,
        });
      }
    }
  }
  return idToWord;
}

async function main() {
  console.log(`Backfilling segment transliterations for language "${language}"${dryRun ? " (DRY RUN)" : ""}...\n`);

  const snap = await exampleSentences.where("language", "==", language).get();
  console.log(`Found ${snap.size} example sentences.`);

  // Collect all unique word IDs referenced by linked segments
  const allWordIds = new Set<string>();
  for (const doc of snap.docs) {
    const segs = doc.data().segments as Segment[] | undefined;
    if (!Array.isArray(segs)) continue;
    for (const seg of segs) {
      if (seg.id) allWordIds.add(seg.id);
    }
  }
  console.log(`Found ${allWordIds.size} unique linked word IDs.`);

  if (allWordIds.size === 0) {
    console.log("No linked segments — nothing to do.");
    return;
  }

  const idToWord = await fetchWordDocs([...allWordIds]);
  console.log(`Fetched ${idToWord.size} word docs.\n`);

  let sentencesUpdated = 0;
  let segmentsFixed = 0;
  let segmentsSkippedPolyphonic = 0;

  const BATCH_LIMIT = 500;
  let batch = db.batch();
  let batchCount = 0;

  const flush = async () => {
    if (batchCount === 0) return;
    if (!dryRun) await batch.commit();
    batch = db.batch();
    batchCount = 0;
  };

  for (const doc of snap.docs) {
    const segs = doc.data().segments as Segment[] | undefined;
    if (!Array.isArray(segs) || segs.length === 0) continue;

    let changed = false;
    const newSegs: Segment[] = segs.map((seg) => {
      if (!seg.id) return seg;
      const word = idToWord.get(seg.id);
      if (!word) return seg;
      const canonical = getCanonicalPinyin(word);
      if (canonical === undefined) {
        segmentsSkippedPolyphonic++;
        return seg;
      }
      if (seg.transliteration === canonical) return seg;
      changed = true;
      segmentsFixed++;
      console.log(`  [${doc.id}] "${seg.text}": "${seg.transliteration}" → "${canonical}"`);
      return { ...seg, transliteration: canonical };
    });

    if (!changed) continue;
    sentencesUpdated++;

    if (!dryRun) {
      batch.update(exampleSentences.doc(doc.id), { segments: newSegs });
      batchCount++;
      if (batchCount >= BATCH_LIMIT) await flush();
    }
  }

  await flush();

  console.log("\n--- Done ---");
  console.log(`Example sentences updated: ${sentencesUpdated}`);
  console.log(`Segments fixed:            ${segmentsFixed}`);
  console.log(`Segments skipped (polyphonic): ${segmentsSkippedPolyphonic}`);
  if (dryRun) console.log("(dry-run — no Firestore writes were made)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
