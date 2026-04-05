/**
 * One-time migration script: unify Chinese word levels in Firestore.
 *
 * Maps granular HSK levels to unified groups:
 *   HSK1, HSK2, HSK3, HSK4 (and their -extended variants) → HSK1-4
 *   HSK5, HSK5-extended → HSK5
 *   HSK6, HSK6-extended → HSK6
 *   HSK7-9, HSK7-9-extended → HSK7-9
 *   Advanced → Advanced
 *
 * Usage:
 *   cd backend && npx tsx scripts/unify-chinese-levels.ts
 */

import { Firestore } from "@google-cloud/firestore";

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

const words = db.collection("words");
const wordIndex = db.collection("word_index");

const LEVEL_MAP: Record<string, string> = {
  HSK1: "HSK1-4",
  HSK2: "HSK1-4",
  HSK3: "HSK1-4",
  HSK4: "HSK1-4",
  "HSK1-extended": "HSK1-4",
  "HSK2-extended": "HSK1-4",
  "HSK3-extended": "HSK1-4",
  "HSK4-extended": "HSK1-4",
  HSK5: "HSK5",
  "HSK5-extended": "HSK5",
  HSK6: "HSK6",
  "HSK6-extended": "HSK6",
  "HSK7-9": "HSK7-9",
  "HSK7-9-extended": "HSK7-9",
  Advanced: "Advanced",
};

async function main() {
  console.log("Fetching all Chinese words...");
  const snap = await words.where("language", "==", "chinese").get();
  console.log(`Found ${snap.size} words`);

  const BATCH_LIMIT = 500;
  let updated = 0;
  let skipped = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const doc of snap.docs) {
    const level = doc.data().level as string | undefined;
    if (!level) {
      skipped++;
      continue;
    }

    const newLevel = LEVEL_MAP[level];
    if (!newLevel) {
      console.warn(`  Unknown level "${level}" on ${doc.id} — skipping`);
      skipped++;
      continue;
    }
    if (newLevel === level) {
      skipped++;
      continue;
    }

    batch.update(words.doc(doc.id), { level: newLevel });
    batchCount++;
    updated++;

    if (batchCount >= BATCH_LIMIT) {
      await batch.commit();
      console.log(`  Committed ${updated} word updates so far...`);
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }
  console.log(`Words: ${updated} updated, ${skipped} skipped`);

  // Update word_index entries
  console.log("\nUpdating word_index...");
  const indexSnap = await wordIndex.where("language", "==", "chinese").get();
  console.log(`Found ${indexSnap.size} index entries`);

  let idxUpdated = 0;
  let idxSkipped = 0;
  batch = db.batch();
  batchCount = 0;

  for (const doc of indexSnap.docs) {
    const level = doc.data().level as string | undefined;
    if (!level) {
      idxSkipped++;
      continue;
    }

    const newLevel = LEVEL_MAP[level];
    if (!newLevel || newLevel === level) {
      idxSkipped++;
      continue;
    }

    batch.update(wordIndex.doc(doc.id), { level: newLevel });
    batchCount++;
    idxUpdated++;

    if (batchCount >= BATCH_LIMIT) {
      await batch.commit();
      console.log(`  Committed ${idxUpdated} index updates so far...`);
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }
  console.log(`Word index: ${idxUpdated} updated, ${idxSkipped} skipped`);

  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
