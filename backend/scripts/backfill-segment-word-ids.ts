/**
 * Backfill segment word IDs in example sentences.
 *
 * Scans all example sentences for a given language and, for each segment
 * without an `id`, looks up its text in `word_index`. If a match exists,
 * the word ID is assigned to the segment and the matched word's
 * `appearsInIds` is updated.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-segment-word-ids.ts [--language=chinese] [--dry-run]
 *
 * Default language: chinese
 */

import { Firestore, FieldValue } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.find((a) => a.startsWith("--language="));
const language = langArg ? langArg.split("=")[1] : "chinese";

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const exampleSentences = db.collection("example_sentences");
const wordIndex = db.collection("word_index");
const wordsCol = db.collection("words");

interface Segment {
  text: string;
  transliteration?: string;
  pinyin?: string;
  id?: string;
}

async function lookupWordsByTerms(lang: string, terms: string[]): Promise<Map<string, string>> {
  const termToId = new Map<string, string>();
  const CHUNK = 100;
  for (let i = 0; i < terms.length; i += CHUNK) {
    const chunk = terms.slice(i, i + CHUNK);
    const refs = chunk.map((t) => wordIndex.doc(`${lang}_${t}`));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      if (doc.exists) {
        const d = doc.data()!;
        termToId.set(d.term as string, d.id as string);
      }
    }
  }
  return termToId;
}

async function backfill() {
  console.log(`Backfilling segment word IDs for language "${language}"${dryRun ? " (DRY RUN)" : ""}...\n`);

  // Fetch all example sentences for the language
  const snap = await exampleSentences.where("language", "==", language).get();
  console.log(`Found ${snap.size} example sentences.`);

  // Pass 1: collect all segment texts that lack an id
  const unresolvedTexts = new Set<string>();
  const sentenceSegments = new Map<string, Segment[]>();
  for (const doc of snap.docs) {
    const d = doc.data();
    const segs = d.segments as Segment[] | undefined;
    if (!Array.isArray(segs) || segs.length === 0) continue;
    sentenceSegments.set(doc.id, segs);
    for (const seg of segs) {
      if (!seg.id && seg.text && seg.text.trim()) {
        unresolvedTexts.add(seg.text);
      }
    }
  }

  console.log(`Found ${unresolvedTexts.size} unique segment texts without word ID.`);

  if (unresolvedTexts.size === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // Pass 2: bulk lookup in word_index
  const termToId = await lookupWordsByTerms(language, [...unresolvedTexts]);
  console.log(`Matched ${termToId.size} segment texts to existing words.`);

  if (termToId.size === 0) {
    console.log("No matches found. Nothing to update.");
    return;
  }

  // Pass 3: for each example sentence with newly-resolvable segments,
  // update segments + track which words need appearsInIds updated
  const wordAppearsIn = new Map<string, Set<string>>(); // wordId -> set of exampleIds
  const sentenceUpdates = new Map<string, Segment[]>(); // exampleId -> new segments
  let totalSegmentsLinked = 0;

  for (const [exId, segs] of sentenceSegments) {
    let changed = false;
    const newSegs: Segment[] = segs.map((seg) => {
      if (!seg.id && termToId.has(seg.text)) {
        const wId = termToId.get(seg.text)!;
        changed = true;
        totalSegmentsLinked++;
        if (!wordAppearsIn.has(wId)) wordAppearsIn.set(wId, new Set());
        wordAppearsIn.get(wId)!.add(exId);
        return { ...seg, id: wId };
      }
      // Collect existing links too so appearsInIds stays accurate
      if (seg.id) {
        if (!wordAppearsIn.has(seg.id)) wordAppearsIn.set(seg.id, new Set());
        wordAppearsIn.get(seg.id)!.add(exId);
      }
      return seg;
    });
    if (changed) sentenceUpdates.set(exId, newSegs);
  }

  console.log(`\n${totalSegmentsLinked} segments newly linked across ${sentenceUpdates.size} example sentences.`);

  if (dryRun) {
    console.log(`[DRY RUN] Would update ${sentenceUpdates.size} example sentences.`);
    console.log(`[DRY RUN] Would update appearsInIds on ${wordAppearsIn.size} words.`);
    // Print a preview of up to 10 newly-linked terms
    const preview = [...termToId.entries()].slice(0, 10);
    console.log("\nPreview of newly-linked terms:");
    for (const [term, wId] of preview) {
      console.log(`  "${term}" -> ${wId}`);
    }
    return;
  }

  // Pass 4: commit updates
  const BATCH_LIMIT = 500;
  let batch = db.batch();
  let batchCount = 0;

  // Update example sentences with new segments
  for (const [exId, newSegs] of sentenceUpdates) {
    batch.update(exampleSentences.doc(exId), { segments: newSegs });
    batchCount++;
    if (batchCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) {
    await batch.commit();
    batch = db.batch();
    batchCount = 0;
  }
  console.log(`Updated ${sentenceUpdates.size} example sentences.`);

  // Update words' appearsInIds (only for words that gained new links)
  // Only update words where the backfill added something new.
  const wordsToUpdate = new Set<string>();
  for (const [exId, newSegs] of sentenceUpdates) {
    for (const seg of newSegs) {
      if (seg.id) wordsToUpdate.add(seg.id);
    }
  }

  // Verify target words actually exist before updating (defensive)
  const wordIdList = [...wordsToUpdate];
  const existingWordIds = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < wordIdList.length; i += CHUNK) {
    const refs = wordIdList.slice(i, i + CHUNK).map((id) => wordsCol.doc(id));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      if (doc.exists) existingWordIds.add(doc.id);
    }
  }

  let wordsUpdatedCount = 0;
  for (const wordId of existingWordIds) {
    const exIds = wordAppearsIn.get(wordId);
    if (!exIds || exIds.size === 0) continue;
    // arrayUnion is safe: it only adds values not already present
    batch.update(wordsCol.doc(wordId), {
      appearsInIds: FieldValue.arrayUnion(...exIds),
    });
    batchCount++;
    wordsUpdatedCount++;
    if (batchCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) await batch.commit();
  console.log(`Updated appearsInIds on ${wordsUpdatedCount} words.`);

  console.log(`\n=== Backfill complete ===`);
  console.log(`  Segments newly linked: ${totalSegmentsLinked}`);
  console.log(`  Example sentences updated: ${sentenceUpdates.size}`);
  console.log(`  Words updated (appearsInIds): ${wordsUpdatedCount}`);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
