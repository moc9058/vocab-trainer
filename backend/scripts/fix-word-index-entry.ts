/**
 * Fix a corrupted word_index entry for a specific term.
 *
 * Two repair modes depending on whether the correct word exists in `words`:
 *
 * A. Correct word EXISTS: repairs word_index to point to it, then fixes all
 *    example sentence segments that have the wrong seg.id (correcting both
 *    seg.id and seg.transliteration). Also patches appearsInIds.
 *
 * B. Correct word DOES NOT EXIST (orphaned/corrupted index entry): deletes the
 *    bad word_index doc and clears the wrong seg.id from affected example
 *    sentence segments. Reports how many sentences were affected.
 *
 * Usage:
 *   cd backend && npx tsx scripts/fix-word-index-entry.ts --term=说过 [--language=chinese] [--dry-run]
 */

// Must stay the FIRST import: it fixes the project for every Firestore client the
// process builds — without it the client resolves to gcloud's default project,
// which has no `vocab-database`, and every query dies with a bare `5 NOT_FOUND`.
import { PROJECT_ID, DATABASE_ID } from "./_project-env.js";
import { Firestore, FieldValue } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.find((a) => a.startsWith("--language="));
const termArg = args.find((a) => a.startsWith("--term="));
const language = langArg ? langArg.split("=")[1] : "chinese";
const term = termArg ? termArg.split("=")[1] : "";

if (!term) {
  console.error("Error: --term=<term> is required.");
  process.exit(1);
}

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  ignoreUndefinedProperties: true,
});

const exampleSentences = db.collection("example_sentences");
const wordIndex = db.collection("word_index");
const wordsCol = db.collection("words");

async function fix() {
  console.log(`Fixing word_index entry for "${term}" (language: ${language})${dryRun ? " [DRY RUN]" : ""}...\n`);

  // Step 1: Read the current word_index entry
  const indexDocId = `${language}_${term}`;
  const indexDoc = await wordIndex.doc(indexDocId).get();
  const currentIndexId = indexDoc.exists ? (indexDoc.data()!.id as string) : null;

  console.log(`word_index["${indexDocId}"] currently points to: ${currentIndexId ?? "(not found)"}`);

  if (currentIndexId) {
    const currentWord = await wordsCol.doc(currentIndexId).get();
    const currentWordTerm = currentWord.exists ? (currentWord.data()!.term as string) : "(word doc missing)";
    console.log(`  → that word has term="${currentWordTerm}"`);
  }

  // Step 2: Find the correct word by querying words collection
  const wordSnap = await wordsCol
    .where("language", "==", language)
    .where("term", "==", term)
    .limit(2)
    .get();

  if (wordSnap.empty) {
    // Mode B: no correct word exists — orphaned/corrupted index entry
    console.log(`\nNo word found in words collection for term="${term}". `);
    console.log("Mode B: will delete corrupted word_index entry and clear wrong seg.id from segments.\n");

    await fixOrphaned(indexDocId, currentIndexId);
    return;
  }

  if (wordSnap.size > 1) {
    console.warn(`Warning: ${wordSnap.size} words found for term="${term}". Using the first one.`);
  }

  const correctWordDoc = wordSnap.docs[0];
  const correctWordId = correctWordDoc.id;
  const correctWordData = correctWordDoc.data();
  const correctTransliteration = (correctWordData.transliteration ?? "") as string;
  const correctLevel = (correctWordData.level ?? "") as string;

  console.log(`Correct word: id=${correctWordId}, transliteration="${correctTransliteration}", level="${correctLevel}"`);

  if (currentIndexId === correctWordId) {
    console.log("\nword_index entry is already correct. Checking for mislinked segments anyway...");
  }

  // Step 3: Fix word_index if needed
  const indexNeedsUpdate = currentIndexId !== correctWordId;
  if (indexNeedsUpdate) {
    console.log(`\n→ word_index needs repair: "${currentIndexId}" → "${correctWordId}"`);
    if (!dryRun) {
      await wordIndex.doc(indexDocId).set({
        language,
        term,
        id: correctWordId,
        transliteration: correctTransliteration,
        level: correctLevel,
      });
      console.log(`  ✓ word_index["${indexDocId}"] updated.`);
    } else {
      console.log(`  [DRY RUN] Would update word_index["${indexDocId}"].`);
    }
  }

  // Step 4: Find all example sentences with mislinked segments for this term
  const snap = await exampleSentences.where("language", "==", language).get();
  console.log(`\nScanning ${snap.size} example sentences for segments with text="${term}" and wrong id...`);

  const toFix: Array<{ exId: string; sentence: string; oldSegId: string | undefined; segs: any[] }> = [];

  for (const doc of snap.docs) {
    const d = doc.data();
    const segs = d.segments as any[] | undefined;
    if (!Array.isArray(segs)) continue;

    const hasWrongSeg = segs.some((s) => s.text === term && s.id !== correctWordId);
    if (hasWrongSeg) {
      const wrongSeg = segs.find((s) => s.text === term && s.id !== correctWordId);
      toFix.push({
        exId: doc.id,
        sentence: d.sentence as string,
        oldSegId: wrongSeg?.id,
        segs,
      });
    }
  }

  if (toFix.length === 0) {
    console.log("No example sentences have mislinked segments for this term.");
    if (!indexNeedsUpdate) console.log("Nothing to fix.");
    return;
  }

  console.log(`Found ${toFix.length} example sentence(s) with mislinked segments:`);
  for (const item of toFix) {
    console.log(`  ${item.exId}: "${item.sentence}"`);
    console.log(`    seg.id: ${item.oldSegId ?? "(none)"} → ${correctWordId}`);
    console.log(`    seg.transliteration: → "${correctTransliteration}"`);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would fix ${toFix.length} example sentence(s). No changes written.`);
    return;
  }

  // Step 5: Fix segments in example sentences
  const wrongWordIds = new Set<string>();
  for (const item of toFix) {
    const fixedSegs = item.segs.map((seg) => {
      if (seg.text !== term || seg.id === correctWordId) return seg;
      if (seg.id) wrongWordIds.add(seg.id);
      return {
        ...seg,
        id: correctWordId,
        ...(correctTransliteration ? { transliteration: correctTransliteration } : {}),
      };
    });
    await exampleSentences.doc(item.exId).update({ segments: fixedSegs });
    console.log(`  ✓ Fixed segments in ${item.exId}: "${item.sentence}"`);
  }

  // Step 6: Fix appearsInIds
  const fixedExIds = toFix.map((i) => i.exId);

  for (const wrongWordId of wrongWordIds) {
    const wrongWordDoc = await wordsCol.doc(wrongWordId).get();
    if (!wrongWordDoc.exists) continue;
    await wordsCol.doc(wrongWordId).update({
      appearsInIds: FieldValue.arrayRemove(...fixedExIds),
    });
    console.log(`  ✓ Removed stale appearsInIds from wrong word "${wrongWordId}" (term="${wrongWordDoc.data()!.term}")`);
  }

  await wordsCol.doc(correctWordId).update({
    appearsInIds: FieldValue.arrayUnion(...fixedExIds),
  });
  console.log(`  ✓ Added appearsInIds to correct word "${correctWordId}" (term="${term}")`);

  console.log("\n=== Fix complete (Mode A) ===");
  if (indexNeedsUpdate) console.log("  word_index entry: repaired");
  console.log(`  Example sentences fixed: ${toFix.length}`);
  console.log(`  Wrong words cleaned up (appearsInIds): ${wrongWordIds.size}`);
}

async function fixOrphaned(indexDocId: string, currentIndexId: string | null) {
  // Find all example sentences with seg.id pointing to the wrong word
  const snap = await exampleSentences.where("language", "==", language).get();
  console.log(`Scanning ${snap.size} example sentences for segments with text="${term}"...`);

  const toFix: Array<{ exId: string; sentence: string; wrongSegId: string; segs: any[] }> = [];

  for (const doc of snap.docs) {
    const d = doc.data();
    const segs = d.segments as any[] | undefined;
    if (!Array.isArray(segs)) continue;

    const wrongSeg = segs.find((s) => s.text === term && s.id);
    if (wrongSeg) {
      toFix.push({
        exId: doc.id,
        sentence: d.sentence as string,
        wrongSegId: wrongSeg.id,
        segs,
      });
    }
  }

  console.log(`Found ${toFix.length} example sentence(s) with a seg.id for "${term}":`);
  for (const item of toFix) {
    console.log(`  ${item.exId}: "${item.sentence}" — seg.id="${item.wrongSegId}" will be cleared`);
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] Would delete word_index["${indexDocId}"] and clear seg.id in ${toFix.length} sentences. No changes written.`);
    return;
  }

  // Delete the corrupted word_index entry
  if (indexDocId) {
    await wordIndex.doc(indexDocId).delete();
    console.log(`\n  ✓ Deleted corrupted word_index["${indexDocId}"]`);
  }

  // Clear the wrong seg.id from example sentences
  const wrongWordIds = new Set<string>();
  for (const item of toFix) {
    const fixedSegs = item.segs.map((seg) => {
      if (seg.text !== term || !seg.id) return seg;
      wrongWordIds.add(seg.id);
      const { id: _id, ...rest } = seg;
      return rest;
    });
    await exampleSentences.doc(item.exId).update({ segments: fixedSegs });
    console.log(`  ✓ Cleared seg.id in ${item.exId}: "${item.sentence}"`);
  }

  // Remove stale appearsInIds from the wrong word
  if (toFix.length > 0) {
    const fixedExIds = toFix.map((i) => i.exId);
    for (const wrongWordId of wrongWordIds) {
      const wrongWordDoc = await wordsCol.doc(wrongWordId).get();
      if (!wrongWordDoc.exists) continue;
      await wordsCol.doc(wrongWordId).update({
        appearsInIds: FieldValue.arrayRemove(...fixedExIds),
      });
      console.log(`  ✓ Removed stale appearsInIds from wrong word "${wrongWordId}" (term="${wrongWordDoc.data()!.term}")`);
    }
  }

  console.log("\n=== Fix complete (Mode B) ===");
  console.log(`  word_index["${indexDocId}"]: deleted`);
  console.log(`  Example sentences with cleared seg.id: ${toFix.length}`);
}

fix().catch((err) => {
  console.error("Fix failed:", err);
  process.exit(1);
});
