/**
 * Migration script: extracts embedded examples from words into a dedicated
 * `example_sentences` collection, deduplicates by sentence text, and sets up
 * bidirectional word <-> example sentence links.
 *
 * Also cleans up:
 * - Duplicate words (same term in same language): keeps the smaller ID,
 *   merges examples from the larger, deletes the larger doc + index entry.
 * - Stale segment word IDs: removes segment.id when the referenced word
 *   does not exist.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-example-sentences.ts [--dry-run]
 *
 * Idempotent: skips words that already have `exampleIds`.
 */

import { Firestore, FieldPath, FieldValue } from "@google-cloud/firestore";
import { createHash } from "crypto";
import type { ExampleSentence } from "../src/types.js";

const dryRun = process.argv.includes("--dry-run");

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const wordsCol = db.collection("words");
const wordIndex = db.collection("word_index");
const exampleSentences = db.collection("example_sentences");
const exampleSentenceIndex = db.collection("example_sentence_index");
const idMaps = db.collection("id_maps");
const flaggedWords = db.collection("flagged_words");
const progressCol = db.collection("progress");

const ISO_MAP: Record<string, string> = {
  chinese: "zh", english: "en", french: "fr", german: "de",
  italian: "it", japanese: "ja", korean: "ko", portuguese: "pt",
  russian: "ru", spanish: "es",
};

function indexId(language: string, sentence: string): string {
  const hash = createHash("sha256").update(sentence).digest("hex").slice(0, 16);
  return `${language}_${hash}`;
}

interface RawWord {
  id: string;
  language: string;
  term: string;
  examples: RawExample[];
  doc: FirebaseFirestore.DocumentSnapshot;
}

interface RawExample {
  sentence: string;
  translation: string | Record<string, string>;
  segments?: { text: string; transliteration?: string; pinyin?: string; id?: string }[];
}

async function migrate() {
  console.log(`Starting example sentence migration${dryRun ? " (DRY RUN)" : ""}...\n`);

  // Fetch all words
  const snap = await wordsCol.get();
  console.log(`Found ${snap.size} word documents.`);

  // Group by language
  const wordsByLang = new Map<string, RawWord[]>();
  let skipped = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    if (Array.isArray(d.exampleIds)) {
      skipped++;
      continue;
    }
    const language = d.language as string;
    if (!language) continue;
    const examples = (d.examples ?? []) as RawExample[];
    if (!wordsByLang.has(language)) wordsByLang.set(language, []);
    wordsByLang.get(language)!.push({ id: doc.id, language, term: d.term as string, examples, doc });
  }

  if (skipped > 0) console.log(`Skipped ${skipped} already-migrated words.`);

  let totalExamplesCreated = 0;
  let totalWordsUpdated = 0;
  let totalDuplicatesRemoved = 0;

  for (const [language, langWords] of wordsByLang) {
    console.log(`\nProcessing language: ${language} (${langWords.length} words)`);

    // ── Step 0: Deduplicate words with the same term ──
    // Group by term, keep the smallest ID, merge examples from larger IDs.
    const byTerm = new Map<string, RawWord[]>();
    for (const w of langWords) {
      if (!byTerm.has(w.term)) byTerm.set(w.term, []);
      byTerm.get(w.term)!.push(w);
    }

    // Build a set of all valid word IDs (after dedup) for this language
    const validWordIds = new Set<string>();
    // Map from deleted duplicate ID -> canonical (kept) ID for segment rewriting
    const duplicateIdMap = new Map<string, string>();
    const duplicatesToDelete: RawWord[] = [];
    // The surviving words list (after dedup)
    const survivingWords: RawWord[] = [];

    for (const [term, group] of byTerm) {
      if (group.length === 1) {
        survivingWords.push(group[0]);
        validWordIds.add(group[0].id);
        continue;
      }

      // Sort by ID ascending — keep the smallest
      group.sort((a, b) => a.id.localeCompare(b.id));
      const keeper = group[0];
      validWordIds.add(keeper.id);

      // Merge examples from duplicates into the keeper
      for (let i = 1; i < group.length; i++) {
        const dup = group[i];
        // Append duplicate's examples (dedup by sentence text happens later)
        keeper.examples.push(...dup.examples);
        duplicateIdMap.set(dup.id, keeper.id);
        duplicatesToDelete.push(dup);
      }

      survivingWords.push(keeper);
      console.log(`  Dedup: "${term}" — keeping ${keeper.id}, removing ${group.slice(1).map((g) => g.id).join(", ")}`);
    }

    // Delete duplicate word docs, word_index entries, flagged entries, progress
    if (duplicatesToDelete.length > 0) {
      console.log(`  Deleting ${duplicatesToDelete.length} duplicate word docs...`);
      if (!dryRun) {
        const BATCH_LIMIT = 500;
        let batch = db.batch();
        let batchCount = 0;
        for (const dup of duplicatesToDelete) {
          batch.delete(wordsCol.doc(dup.id));
          batch.delete(wordIndex.doc(`${language}_${dup.term}`));
          batch.delete(flaggedWords.doc(`${language}_${dup.id}`));
          batch.delete(progressCol.doc(`${language}_${dup.id}`));
          batchCount += 4;
          if (batchCount >= BATCH_LIMIT) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }
        if (batchCount > 0) await batch.commit();
      }
      totalDuplicatesRemoved += duplicatesToDelete.length;
    }

    // ── Step 1: Assign example sentences, dedup by sentence text ──
    const prefix = `exs-${ISO_MAP[language.toLowerCase()] ?? language.slice(0, 2).toLowerCase()}`;
    let nextId = 1;

    const idMapDoc = await idMaps.doc(`example_sentences_${language}`).get();
    if (idMapDoc.exists) {
      nextId = idMapDoc.data()!.next_id as number;
    }

    const dedupMap = new Map<string, ExampleSentence>();
    const wordExampleIds = new Map<string, string[]>();

    for (const w of survivingWords) {
      const exIds: string[] = [];

      for (const ex of w.examples) {
        if (!ex.sentence) continue;
        const key = ex.sentence;

        // Rewrite segment IDs: remap duplicate IDs to canonical, remove non-existent
        const cleanedSegments = ex.segments?.map((seg) => {
          let id = seg.id;
          if (id) {
            // Remap duplicate word ID to the canonical keeper
            if (duplicateIdMap.has(id)) id = duplicateIdMap.get(id)!;
            // Remove if word doesn't exist
            if (!validWordIds.has(id)) id = undefined;
          }
          return {
            text: seg.text,
            transliteration: seg.transliteration ?? seg.pinyin,
            ...(id ? { id } : {}),
          };
        });

        if (dedupMap.has(key)) {
          const existing = dedupMap.get(key)!;
          if (cleanedSegments && cleanedSegments.length > 0) {
            existing.segments = cleanedSegments;
          }
          exIds.push(existing.id);
        } else {
          const id = `${prefix}-${String(nextId++).padStart(6, "0")}`;
          const es: ExampleSentence = {
            id,
            sentence: ex.sentence,
            translation: ex.translation,
            segments: cleanedSegments,
            language,
            ownerWordId: w.id,
          };
          dedupMap.set(key, es);
          exIds.push(id);
        }
      }

      wordExampleIds.set(w.id, exIds);
    }

    console.log(`  ${dedupMap.size} unique example sentences, ${survivingWords.length} words to update`);

    // ── Step 2: Build reverse-links (appearsInIds) ──
    const wordAppearsIn = new Map<string, Set<string>>();
    for (const es of dedupMap.values()) {
      if (!es.segments) continue;
      for (const seg of es.segments) {
        if (!seg.id) continue;
        if (!wordAppearsIn.has(seg.id)) wordAppearsIn.set(seg.id, new Set());
        wordAppearsIn.get(seg.id)!.add(es.id);
      }
    }

    if (dryRun) {
      console.log(`  [DRY RUN] Would create ${dedupMap.size} example sentences`);
      console.log(`  [DRY RUN] Would update ${survivingWords.length} words`);
      const reverseLinked = [...wordAppearsIn.entries()].filter(([, s]) => s.size > 0).length;
      console.log(`  [DRY RUN] ${reverseLinked} words would get appearsInIds`);
      continue;
    }

    // ── Step 3: Write example sentence docs ──
    const BATCH_LIMIT = 250;
    let batch = db.batch();
    let batchCount = 0;

    for (const es of dedupMap.values()) {
      const data: Record<string, unknown> = { ...es };
      delete data.id;
      batch.set(exampleSentences.doc(es.id), data);
      batch.set(exampleSentenceIndex.doc(indexId(language, es.sentence)), { exampleId: es.id });
      batchCount += 2;

      if (batchCount >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }
    if (batchCount > 0) {
      await batch.commit();
    }
    totalExamplesCreated += dedupMap.size;

    // ── Step 4: Update surviving word docs ──
    batch = db.batch();
    batchCount = 0;

    // Reverse-link word IDs are already validated (only validWordIds are in segments)
    const allWordIdsToUpdate = new Set([
      ...survivingWords.map((w) => w.id),
      ...[...wordAppearsIn.keys()].filter((id) => validWordIds.has(id)),
    ]);

    for (const wordId of allWordIdsToUpdate) {
      const exIds = wordExampleIds.get(wordId) ?? [];
      const appearsIn = wordAppearsIn.get(wordId);
      const appearsInFiltered = appearsIn
        ? [...appearsIn].filter((eid) => !exIds.includes(eid))
        : [];

      const updateData: Record<string, unknown> = {
        exampleIds: exIds,
        appearsInIds: appearsInFiltered,
      };

      if (wordExampleIds.has(wordId)) {
        updateData.examples = FieldValue.delete();
      }

      batch.update(wordsCol.doc(wordId), updateData);
      batchCount++;

      if (batchCount >= 500) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }
    if (batchCount > 0) {
      await batch.commit();
    }
    totalWordsUpdated += allWordIdsToUpdate.size;

    // Update id_maps counter
    await idMaps.doc(`example_sentences_${language}`).set({ next_id: nextId });
    console.log(`  Done. Next example ID: ${nextId}`);
  }

  console.log(`\n=== Migration complete ===`);
  console.log(`  Example sentences created: ${totalExamplesCreated}`);
  console.log(`  Words updated: ${totalWordsUpdated}`);
  console.log(`  Duplicate words removed: ${totalDuplicatesRemoved}`);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
