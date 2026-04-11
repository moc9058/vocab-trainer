/**
 * Reconcile `appearsInIds` on words.
 *
 * For each word, `appearsInIds` should contain the union of:
 *   1. Example sentences that reference the word via a segment `id`
 *   2. The word's own `exampleIds` (examples owned by the word)
 *
 * This script scans all example sentences + words for a given language,
 * computes that union per word, and writes the diff:
 *
 *   - Missing links are added
 *   - Stale links are removed
 *   - If the union is empty, the field is deleted entirely
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-word-appears-in.ts [--language=chinese] [--dry-run]
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
const wordsCol = db.collection("words");

interface Segment {
  text: string;
  transliteration?: string;
  id?: string;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

async function backfill() {
  console.log(`Reconciling word appearsInIds for language "${language}"${dryRun ? " (DRY RUN)" : ""}...\n`);

  // Pass 1: build wordId -> Set<exampleId> from segment references
  const exSnap = await exampleSentences.where("language", "==", language).get();
  console.log(`Found ${exSnap.size} example sentences.`);

  const desired = new Map<string, Set<string>>(); // wordId -> exampleIds
  for (const doc of exSnap.docs) {
    const d = doc.data();
    const segs = d.segments as Segment[] | undefined;
    if (!Array.isArray(segs) || segs.length === 0) continue;
    for (const seg of segs) {
      if (!seg.id) continue;
      if (!desired.has(seg.id)) desired.set(seg.id, new Set());
      desired.get(seg.id)!.add(doc.id);
    }
  }
  console.log(`Found ${desired.size} distinct words referenced by segments.`);

  // Pass 2: fetch all words in this language and compare
  const wordSnap = await wordsCol.where("language", "==", language).get();
  console.log(`Found ${wordSnap.size} words.`);

  interface Update {
    wordId: string;
    target: string[];
    added: number;
    removed: number;
    deleteField: boolean;
    hadField: boolean;
  }
  const updates: Update[] = [];
  const orphanWordIds: string[] = []; // words referenced by segments but not in wordSnap

  const seenWordIds = new Set<string>();
  for (const doc of wordSnap.docs) {
    seenWordIds.add(doc.id);
    const d = doc.data();
    const hadField = d.appearsInIds !== undefined;
    const current = new Set<string>(Array.isArray(d.appearsInIds) ? (d.appearsInIds as string[]) : []);
    // Union of segment-derived examples + the word's own exampleIds
    const want = new Set<string>(desired.get(doc.id) ?? []);
    if (Array.isArray(d.exampleIds)) {
      for (const exId of d.exampleIds as string[]) want.add(exId);
    }

    // If target is empty, delete the field entirely (if present)
    if (want.size === 0) {
      if (!hadField) continue;
      updates.push({
        wordId: doc.id,
        target: [],
        added: 0,
        removed: current.size,
        deleteField: true,
        hadField,
      });
      continue;
    }

    if (setsEqual(current, want)) continue;

    let added = 0;
    for (const v of want) if (!current.has(v)) added++;
    let removed = 0;
    for (const v of current) if (!want.has(v)) removed++;

    updates.push({ wordId: doc.id, target: [...want], added, removed, deleteField: false, hadField });
  }

  for (const wId of desired.keys()) {
    if (!seenWordIds.has(wId)) orphanWordIds.push(wId);
  }

  if (orphanWordIds.length > 0) {
    console.log(`\nWarning: ${orphanWordIds.length} word(s) referenced by segments do not exist or are in a different language:`);
    for (const id of orphanWordIds.slice(0, 10)) console.log(`  - ${id}`);
    if (orphanWordIds.length > 10) console.log(`  ... and ${orphanWordIds.length - 10} more`);
  }

  const totalAdded = updates.reduce((s, u) => s + u.added, 0);
  const totalRemoved = updates.reduce((s, u) => s + u.removed, 0);
  const totalDeletedFields = updates.filter((u) => u.deleteField).length;
  console.log(`\n${updates.length} words need updates: +${totalAdded} added, -${totalRemoved} removed, ${totalDeletedFields} fields deleted.`);

  if (updates.length === 0) {
    console.log("All appearsInIds are already in sync. Nothing to update.");
    return;
  }

  if (dryRun) {
    console.log(`[DRY RUN] Would update appearsInIds on ${updates.length} words.`);
    console.log("\nPreview (first 10):");
    for (const u of updates.slice(0, 10)) {
      const suffix = u.deleteField ? " [delete field]" : ` → size ${u.target.length}`;
      console.log(`  ${u.wordId}: +${u.added} / -${u.removed}${suffix}`);
    }
    return;
  }

  // Pass 3: commit updates in batches
  const BATCH_LIMIT = 500;
  let batch = db.batch();
  let batchCount = 0;

  for (const u of updates) {
    const value = u.deleteField ? FieldValue.delete() : u.target;
    batch.update(wordsCol.doc(u.wordId), { appearsInIds: value });
    batchCount++;
    if (batchCount >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) await batch.commit();

  console.log(`\n=== Reconcile complete ===`);
  console.log(`  Words updated: ${updates.length}`);
  console.log(`  Links added: ${totalAdded}`);
  console.log(`  Links removed: ${totalRemoved}`);
  console.log(`  Fields deleted: ${totalDeletedFields}`);
}

backfill().catch((err) => {
  console.error("Reconcile failed:", err);
  process.exit(1);
});
