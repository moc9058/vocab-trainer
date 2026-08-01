/**
 * Generate segments (pinyin) and multi-language translations for example
 * sentences that are missing them.
 *
 * Scans all example sentences for a given language:
 *   - Sentences without segments → batch-segmented via segmentBatch (pinyin)
 *   - Sentences with missing/incomplete translations → batch-translated via
 *     translateSentencesBatch (en/ja/ko for Chinese)
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-missing-segments.ts [--language=chinese] [--dry-run] [--chunk=50]
 *
 * Default language: chinese
 * Default chunk size: 50 sentences per segmentation LLM call, 20 per translation call
 */

// Must stay the FIRST import: it fixes the project for every Firestore client the
// process builds — without it the client resolves to gcloud's default project,
// which has no `vocab-database`, and every query dies with a bare `5 NOT_FOUND`.
import { PROJECT_ID, DATABASE_ID } from "./_project-env.js";
import "dotenv/config";
import { Firestore, FieldValue } from "@google-cloud/firestore";
import { segmentBatch, callLLMFull } from "../src/llm.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.find((a) => a.startsWith("--language="));
const language = langArg ? langArg.split("=")[1] : "chinese";
const chunkArg = args.find((a) => a.startsWith("--chunk="));
const CHUNK_SIZE = chunkArg ? parseInt(chunkArg.split("=")[1], 10) : 50;
const TRANSLATE_CHUNK_SIZE = 20;

// Target translation languages per source language (exclude source)
const TRANSLATION_TARGETS: Record<string, string[]> = {
  chinese: ["en", "ja", "ko"],
  japanese: ["en", "ko", "zh"],
  korean:   ["en", "ja", "zh"],
  english:  ["ja", "ko", "zh"],
};

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  ignoreUndefinedProperties: true,
});

const exampleSentences = db.collection("example_sentences");
const wordIndex = db.collection("word_index");
const wordsCol = db.collection("words");

interface Segment {
  text: string;
  transliteration?: string;
  id?: string;
}

function needsTranslation(
  t: string | Record<string, string> | undefined,
  targets: string[]
): boolean {
  if (t == null || t === "") return true;
  if (typeof t === "object" && Object.keys(t).length === 0) return true;
  if (typeof t === "string") return true; // plain string → not yet a multi-language Record
  return targets.some((l) => !(l in t) || !(t as Record<string, string>)[l]);
}

async function lookupWordsByTerms(lang: string, terms: string[]): Promise<Map<string, string>> {
  const termToId = new Map<string, string>();
  const LOOKUP_CHUNK = 100;
  for (let i = 0; i < terms.length; i += LOOKUP_CHUNK) {
    const chunk = terms.slice(i, i + LOOKUP_CHUNK);
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

async function loadSegmentConfig(): Promise<{ prompt: string; schema: Record<string, unknown> } | undefined> {
  try {
    const snap = await db.collection("config").doc("vocabulary").get();
    if (!snap.exists) return undefined;
    const d = snap.data()!;
    if (d.segmentPrompt && d.segmentSchema) {
      return { prompt: d.segmentPrompt as string, schema: d.segmentSchema as Record<string, unknown> };
    }
  } catch {
    // fall back to hardcoded defaults in segmentBatch
  }
  return undefined;
}

async function translateSentencesBatch(
  items: Array<{ sentence: string; hint?: string }>,
  targetLangs: string[]
): Promise<Map<number, Record<string, string>>> {
  const langLabels: Record<string, string> = { en: "English", ja: "Japanese", ko: "Korean", zh: "Chinese" };
  const langList = targetLangs.map((l) => `${langLabels[l] ?? l} ("${l}")`).join(", ");

  const systemPrompt =
    `You translate sentences into multiple languages. ` +
    `For each numbered sentence, return a JSON object with a "results" array. ` +
    `Each item must have "index" (the sentence number) and one key per target language code with the translated text. ` +
    `Target languages: ${langList}. ` +
    `When an existing translation hint is provided, use it to understand context but still produce all target languages.`;

  const userLines = items.map(({ sentence, hint }, i) => {
    const hintPart = hint ? ` [hint: ${hint}]` : "";
    return `${i}. ${sentence}${hintPart}`;
  });
  const userPrompt = userLines.join("\n");

  const raw = await callLLMFull(systemPrompt, userPrompt, "scripts/backfill-translations");
  const result = new Map<number, Record<string, string>>();

  try {
    const parsed = JSON.parse(raw) as { results?: Array<Record<string, unknown>> };
    for (const entry of parsed.results ?? []) {
      const idx = entry.index as number;
      if (typeof idx !== "number") continue;
      const rec: Record<string, string> = {};
      for (const lang of targetLangs) {
        const val = entry[lang];
        if (typeof val === "string" && val.trim()) rec[lang] = val.trim();
      }
      if (Object.keys(rec).length > 0) result.set(idx, rec);
    }
  } catch {
    // LLM returned malformed JSON — skip this chunk
  }

  return result;
}

async function backfill() {
  console.log(`Backfilling missing segments + translations for language "${language}"${dryRun ? " (DRY RUN)" : ""}...`);
  console.log(`Segment chunk size: ${CHUNK_SIZE} | Translation chunk size: ${TRANSLATE_CHUNK_SIZE}\n`);

  const targetLangs = TRANSLATION_TARGETS[language] ?? [];
  if (targetLangs.length === 0) {
    console.log(`No translation targets configured for language "${language}". Skipping translations.`);
  }

  const segmentConfig = await loadSegmentConfig();
  console.log(segmentConfig ? "Loaded segment config from Firestore." : "No segment config in Firestore — using built-in defaults.");

  // Fetch all example sentences for the language
  const snap = await exampleSentences.where("language", "==", language).get();
  console.log(`Found ${snap.size} total example sentences.\n`);

  // Classify sentences
  const toSegment: Array<{ id: string; sentence: string }> = [];
  const toTranslate: Array<{ id: string; sentence: string; hint?: string }> = [];

  for (const doc of snap.docs) {
    const d = doc.data();
    const segs = d.segments as Segment[] | undefined;
    const trans = d.translation as string | Record<string, string> | undefined;

    if (!Array.isArray(segs) || segs.length === 0) {
      toSegment.push({ id: doc.id, sentence: d.sentence as string });
    }
    if (targetLangs.length > 0 && needsTranslation(trans, targetLangs)) {
      const hint = typeof trans === "string" && trans.trim() ? trans.trim() : undefined;
      toTranslate.push({ id: doc.id, sentence: d.sentence as string, hint });
    }
  }

  console.log(`${toSegment.length} sentences need segmentation.`);
  console.log(`${toTranslate.length} sentences need translation.\n`);

  if (toSegment.length === 0 && toTranslate.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (dryRun) {
    if (toSegment.length > 0) {
      console.log(`[DRY RUN] Would segment ${toSegment.length} sentence(s) in ${Math.ceil(toSegment.length / CHUNK_SIZE)} LLM call(s).`);
      console.log("First 10 sentences to segment:");
      for (const { id, sentence } of toSegment.slice(0, 10)) {
        console.log(`  [${id}] ${sentence}`);
      }
      console.log();
    }
    if (toTranslate.length > 0) {
      console.log(`[DRY RUN] Would translate ${toTranslate.length} sentence(s) in ${Math.ceil(toTranslate.length / TRANSLATE_CHUNK_SIZE)} LLM call(s). Target langs: ${targetLangs.join(", ")}`);
      console.log("First 10 sentences to translate:");
      for (const { id, sentence, hint } of toTranslate.slice(0, 10)) {
        console.log(`  [${id}] ${sentence}${hint ? ` (hint: ${hint})` : ""}`);
      }
    }
    return;
  }

  const BATCH_LIMIT = 500;
  let totalSegmented = 0;
  let totalWordLinked = 0;
  let totalTranslated = 0;

  // ── Segmentation pass ────────────────────────────────────────────────────
  for (let offset = 0; offset < toSegment.length; offset += CHUNK_SIZE) {
    const chunk = toSegment.slice(offset, offset + CHUNK_SIZE);
    const chunkNum = Math.floor(offset / CHUNK_SIZE) + 1;
    const totalChunks = Math.ceil(toSegment.length / CHUNK_SIZE);
    console.log(`Segment chunk ${chunkNum}/${totalChunks}: processing ${chunk.length} sentences...`);

    let segMap: Map<number, Segment[]>;
    try {
      segMap = await segmentBatch(chunk.map((c) => c.sentence), segmentConfig);
    } catch (err) {
      console.error(`  LLM error on segment chunk ${chunkNum}:`, err);
      console.error("  Skipping this chunk.");
      continue;
    }

    const allTexts = new Set<string>();
    for (const [, segs] of segMap) for (const s of segs) allTexts.add(s.text);
    const termToId = allTexts.size > 0
      ? await lookupWordsByTerms(language, [...allTexts])
      : new Map<string, string>();

    const wordAppearsIn = new Map<string, Set<string>>();
    let batch = db.batch();
    let batchCount = 0;
    let chunkSegmented = 0;
    let chunkLinked = 0;

    for (let i = 0; i < chunk.length; i++) {
      const rawSegs = segMap.get(i);
      if (!rawSegs || rawSegs.length === 0) continue;

      const { id: exId } = chunk[i];
      const newSegs: Segment[] = rawSegs.map((s) => {
        const wordId = termToId.get(s.text);
        if (wordId) {
          if (!wordAppearsIn.has(wordId)) wordAppearsIn.set(wordId, new Set());
          wordAppearsIn.get(wordId)!.add(exId);
          chunkLinked++;
          return { text: s.text, transliteration: s.transliteration, id: wordId };
        }
        return { text: s.text, transliteration: s.transliteration };
      });

      batch.update(exampleSentences.doc(exId), { segments: newSegs });
      batchCount++;
      chunkSegmented++;
      if (batchCount >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); batchCount = 0; }
    }
    if (batchCount > 0) { await batch.commit(); batch = db.batch(); batchCount = 0; }

    for (const [wordId, exIds] of wordAppearsIn) {
      batch.update(wordsCol.doc(wordId), { appearsInIds: FieldValue.arrayUnion(...exIds) });
      batchCount++;
      if (batchCount >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); batchCount = 0; }
    }
    if (batchCount > 0) { await batch.commit(); batch = db.batch(); batchCount = 0; }

    totalSegmented += chunkSegmented;
    totalWordLinked += chunkLinked;
    console.log(`  -> ${chunkSegmented} segmented, ${chunkLinked} word links, ${wordAppearsIn.size} words updated.`);
  }

  // ── Translation pass ──────────────────────────────────────────────────────
  if (targetLangs.length > 0) {
    for (let offset = 0; offset < toTranslate.length; offset += TRANSLATE_CHUNK_SIZE) {
      const chunk = toTranslate.slice(offset, offset + TRANSLATE_CHUNK_SIZE);
      const chunkNum = Math.floor(offset / TRANSLATE_CHUNK_SIZE) + 1;
      const totalChunks = Math.ceil(toTranslate.length / TRANSLATE_CHUNK_SIZE);
      console.log(`Translation chunk ${chunkNum}/${totalChunks}: translating ${chunk.length} sentences...`);

      let transMap: Map<number, Record<string, string>>;
      try {
        transMap = await translateSentencesBatch(chunk, targetLangs);
      } catch (err) {
        console.error(`  LLM error on translation chunk ${chunkNum}:`, err);
        console.error("  Skipping this chunk.");
        continue;
      }

      let batch = db.batch();
      let batchCount = 0;
      let chunkTranslated = 0;

      for (let i = 0; i < chunk.length; i++) {
        const rec = transMap.get(i);
        if (!rec || Object.keys(rec).length === 0) continue;

        batch.update(exampleSentences.doc(chunk[i].id), { translation: rec });
        batchCount++;
        chunkTranslated++;
        if (batchCount >= BATCH_LIMIT) { await batch.commit(); batch = db.batch(); batchCount = 0; }
      }
      if (batchCount > 0) await batch.commit();

      totalTranslated += chunkTranslated;
      console.log(`  -> ${chunkTranslated} sentences translated.`);
    }
  }

  console.log(`\n=== Backfill complete ===`);
  console.log(`  Sentences segmented   : ${totalSegmented}`);
  console.log(`  Segment-word links    : ${totalWordLinked}`);
  console.log(`  Sentences translated  : ${totalTranslated}`);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
