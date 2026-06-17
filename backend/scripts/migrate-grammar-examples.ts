/**
 * Migration script: normalizes embedded `Grammar.examples` (inline objects) into
 * the shared `example_sentences` collection.
 *
 * Per grammar item:
 *  1. Dedupe each example by sha256 of sentence text (language-scoped) against
 *     the existing `example_sentence_index`. Reuses the existing doc if present
 *     — this naturally shares with vocab examples that have the same sentence.
 *  2. Creates the example_sentence doc if no match.
 *  3. Writes `exampleIds` onto the grammar doc and deletes the inline `examples`
 *     field.
 *  4. arrayUnion the grammar id into each example's `appearsInGrammarIds`.
 *
 * Idempotent: skips grammar docs that already have `Array.isArray(exampleIds)`.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-grammar-examples.ts [--dry-run] [--language=<lang>]
 */

import { Firestore, FieldValue } from "@google-cloud/firestore";
import { createHash } from "crypto";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.find((a) => a.startsWith("--language="))?.split("=")[1];

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const grammarItems = db.collection("grammar_items");
const exampleSentences = db.collection("example_sentences");
const exampleSentenceIndex = db.collection("example_sentence_index");
const idMaps = db.collection("id_maps");

const ISO_MAP: Record<string, string> = {
  chinese: "zh", english: "en", french: "fr", german: "de",
  italian: "it", japanese: "ja", korean: "ko", portuguese: "pt",
  russian: "ru", spanish: "es",
};

function indexId(language: string, sentence: string): string {
  const hash = createHash("sha256").update(sentence).digest("hex").slice(0, 16);
  return `${language}_${hash}`;
}

async function getNextExampleId(language: string): Promise<string> {
  const docRef = idMaps.doc(`example_sentences_${language}`);
  const prefix = `exs-${ISO_MAP[language.toLowerCase()] ?? language.slice(0, 2).toLowerCase()}`;
  if (dryRun) {
    return `${prefix}-DRYRUN`;
  }
  const doc = await docRef.get();
  let nextId: number;
  if (doc.exists) {
    nextId = doc.data()!.next_id;
    await docRef.update({ next_id: FieldValue.increment(1) });
  } else {
    nextId = 1;
    await docRef.set({ next_id: 2 });
  }
  return `${prefix}-${String(nextId).padStart(6, "0")}`;
}

interface InlineExample {
  sentence: string;
  translation: string;
  transliteration?: string;
}

async function migrate() {
  console.log(`Starting grammar example migration${dryRun ? " (DRY RUN)" : ""}${langArg ? ` (language=${langArg})` : ""}...\n`);

  const snap = langArg
    ? await grammarItems.where("language", "==", langArg).get()
    : await grammarItems.get();

  console.log(`Found ${snap.size} grammar items.`);

  let migrated = 0;
  let skipped = 0;
  let exCreated = 0;
  let exReused = 0;
  let exSkippedEmpty = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    if (Array.isArray(d.exampleIds)) {
      skipped++;
      continue;
    }
    const language = d.language as string;
    if (!language) {
      console.warn(`  ! skipping ${doc.id} — missing language`);
      continue;
    }
    const inline = (d.examples ?? []) as InlineExample[];

    const exampleIds: string[] = [];
    for (const ex of inline) {
      const sentence = (ex.sentence ?? "").trim();
      if (!sentence) {
        exSkippedEmpty++;
        continue;
      }
      const idxId = indexId(language, sentence);
      const idxDoc = await exampleSentenceIndex.doc(idxId).get();

      if (idxDoc.exists) {
        const exId = idxDoc.data()!.exampleId as string;
        exampleIds.push(exId);
        exReused++;
        continue;
      }

      const exId = await getNextExampleId(language);
      exampleIds.push(exId);
      exCreated++;

      if (!dryRun) {
        const data: Record<string, unknown> = {
          sentence,
          translation: ex.translation ?? "",
          language,
        };
        if (ex.transliteration) {
          // Preserve transliteration metadata at the example level so subsequent
          // hydration (vocab or grammar) can keep displaying it.
          data.transliteration = ex.transliteration;
        }
        await exampleSentences.doc(exId).set(data);
        await exampleSentenceIndex.doc(idxId).set({ exampleId: exId });
      }
    }

    if (!dryRun) {
      const batch = db.batch();
      batch.update(grammarItems.doc(doc.id), {
        exampleIds,
        examples: FieldValue.delete(),
      });
      for (const exId of exampleIds) {
        batch.update(exampleSentences.doc(exId), {
          appearsInGrammarIds: FieldValue.arrayUnion(doc.id),
        });
      }
      await batch.commit();
    }

    migrated++;
    console.log(`  ✓ ${doc.id} (${language}): ${exampleIds.length} examples linked (${inline.length} inline → ${exampleIds.length} ids)`);
  }

  console.log(`\nDone${dryRun ? " (DRY RUN — no writes performed)" : ""}.`);
  console.log(`  Items migrated:    ${migrated}`);
  console.log(`  Items skipped:     ${skipped} (already had exampleIds)`);
  console.log(`  Examples created:  ${exCreated}`);
  console.log(`  Examples reused:   ${exReused} (dedup-shared with existing docs)`);
  if (exSkippedEmpty > 0) {
    console.log(`  Empty inline rows skipped: ${exSkippedEmpty}`);
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
