/**
 * seed-download: sample PRODUCTION Firestore into a local snapshot.
 *
 * Usage:
 *   cd backend && npm run seed:download [-- --language=chinese,english] [-- --words=30 --grammar=10 --expressions=20]
 *
 * READ-ONLY against production (requires ADC: `gcloud auth application-default login`).
 * Writes JSON to backend/data/local-seed/ (gitignored); `npm run seed:load` then
 * loads that snapshot into the local Firestore emulator.
 *
 * Sampling is deterministic (evenly-strided over sorted ids) and closes over
 * references: every sampled word/grammar item brings its example_sentences,
 * word_index / progress / flagged_words / grammar_progress entries, and group
 * memberships, with outbound references to UNsampled docs stripped so the local
 * dataset passes validate-invariant-all.ts.
 */

// Must stay the FIRST import: it publishes FIRESTORE_PROJECT to the environment
// before the Firestore client below reads it.
import "./_project-env.js";
import {
  CollectionReference,
  DocumentReference,
  Firestore,
  GeoPoint,
  Timestamp,
} from "@google-cloud/firestore";
import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(__dirname, "../../.env") });

// This script must read PRODUCTION. Kill any emulator routing — whether it came
// from the ambient environment or from the .env loaded above — before the
// client is constructed (the client resolves the emulator host at construction).
delete process.env.FIRESTORE_EMULATOR_HOST;

const PROJECT_ID = process.env.FIRESTORE_PROJECT || "vocab-trainer-490014";
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "vocab-database";

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  ignoreUndefinedProperties: true,
});

const OUT_DIR = resolve(__dirname, "..", "data", "local-seed");

// Mirrors firestore.ts:ISO_MAP — expression_items/expression_groups store the
// ISO code in `language`, unlike words/grammar which store the full name.
const ISO_MAP: Record<string, string> = {
  chinese: "zh", english: "en", french: "fr", german: "de",
  italian: "it", japanese: "ja", korean: "ko", portuguese: "pt",
  russian: "ru", spanish: "es",
};

interface Args {
  languages: string[] | null;
  words: number;
  grammar: number;
  expressions: number;
}

function parseArgs(): Args {
  const args: Args = { languages: null, words: 30, grammar: 10, expressions: 20 };
  for (const arg of process.argv.slice(2)) {
    const langMatch = arg.match(/^--language=(.+)$/);
    if (langMatch) {
      args.languages = langMatch[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      continue;
    }
    const numMatch = arg.match(/^--(words|grammar|expressions)=(\d+)$/);
    if (numMatch) {
      args[numMatch[1] as "words" | "grammar" | "expressions"] = parseInt(numMatch[2], 10);
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    console.error("Usage: npm run seed:download [-- --language=chinese,english --words=30 --grammar=10 --expressions=20]");
    process.exit(1);
  }
  return args;
}

type SnapshotDoc = { id: string; data: Record<string, unknown> };

/** Evenly-strided deterministic sample over the whole (sorted) id space. */
function strideSample<T>(items: T[], n: number): T[] {
  if (n <= 0 || items.length === 0) return [];
  if (items.length <= n) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]);
  return out;
}

/** Batch-fetch docs by id (100-ref chunks, the getWordsByIds pattern). Missing ids are returned separately. */
async function fetchByIds(
  col: CollectionReference,
  ids: string[]
): Promise<{ found: SnapshotDoc[]; missing: string[] }> {
  const unique = [...new Set(ids)];
  const found: SnapshotDoc[] = [];
  const missing: string[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const refs = unique.slice(i, i + 100).map((id) => col.doc(id));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) found.push({ id: snap.id, data: snap.data() as Record<string, unknown> });
      else missing.push(snap.id);
    }
  }
  return { found, missing };
}

/**
 * The codebase stores plain JSON (ISO strings, no rich Firestore types), so this
 * walk is expected to be a no-op — it exists to catch surprises loudly instead
 * of writing unserializable values into the snapshot.
 */
function sanitizeValue(value: unknown, path: string, warnings: Set<string>): unknown {
  if (value instanceof Timestamp) {
    warnings.add(`Timestamp at ${path} converted to ISO string`);
    return value.toDate().toISOString();
  }
  if (value instanceof DocumentReference) {
    warnings.add(`DocumentReference at ${path} converted to its path string`);
    return value.path;
  }
  if (value instanceof GeoPoint) {
    warnings.add(`GeoPoint at ${path} converted to {latitude, longitude}`);
    return { latitude: value.latitude, longitude: value.longitude };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    warnings.add(`Binary value at ${path} converted to base64 string`);
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) return value.map((v, i) => sanitizeValue(v, `${path}[${i}]`, warnings));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValue(v, `${path}.${k}`, warnings);
    }
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("=".repeat(70));
  console.log(`seed-download — reading PRODUCTION (read-only)`);
  console.log(`  project:  ${PROJECT_ID}`);
  console.log(`  database: ${DATABASE_ID}`);
  console.log(`  sample:   ${args.words} words / ${args.grammar} grammar / ${args.expressions} expressions per language`);
  console.log("=".repeat(70));

  const languageDocs = (await db.collection("languages").get()).docs;
  const allLanguages = languageDocs.map((d) => d.id);
  const targetLanguages = args.languages ?? allLanguages;
  const unknown = targetLanguages.filter((l) => !allLanguages.includes(l));
  if (unknown.length > 0) {
    console.error(`Unknown language(s): ${unknown.join(", ")} (available: ${allLanguages.join(", ")})`);
    process.exit(1);
  }
  console.log(`Languages: ${targetLanguages.join(", ")}\n`);

  // collection name -> docs; written one file per collection at the end.
  const snapshot = new Map<string, SnapshotDoc[]>();
  const add = (col: string, docs: SnapshotDoc[]) => {
    snapshot.set(col, [...(snapshot.get(col) ?? []), ...docs]);
  };
  const warnings = new Set<string>();
  const perLanguage: Record<string, Record<string, number>> = {};

  for (const lang of targetLanguages) {
    console.log(`--- ${lang} ---`);

    // 1. Words: cheap __name__-only projection (the getAllWordIds pattern), then
    //    a deterministic stride over the sorted id space so the sample spans old
    //    and new words alike.
    const wordIdSnap = await db.collection("words").where("language", "==", lang).select().get();
    const sampledWordIds = strideSample(wordIdSnap.docs.map((d) => d.id).sort(), args.words);
    const words = (await fetchByIds(db.collection("words"), sampledWordIds)).found;
    const wordIdSet = new Set(words.map((w) => w.id));
    console.log(`  words: ${words.length} of ${wordIdSnap.size}`);

    // 2. Grammar items: same flow.
    const grammarIdSnap = await db.collection("grammar_items").where("language", "==", lang).select().get();
    const sampledGrammarIds = strideSample(grammarIdSnap.docs.map((d) => d.id).sort(), args.grammar);
    const grammarItems = (await fetchByIds(db.collection("grammar_items"), sampledGrammarIds)).found;
    const grammarIdSet = new Set(grammarItems.map((g) => g.id));
    console.log(`  grammar_items: ${grammarItems.length} of ${grammarIdSnap.size}`);

    // 3. Expressions (keyed by ISO code, small collection — plain query then stride).
    const iso = ISO_MAP[lang] ?? lang.slice(0, 2);
    const exprSnap = await db.collection("expression_items").where("language", "==", iso).get();
    const expressions = strideSample(
      exprSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      args.expressions
    );
    const expressionIdSet = new Set<string>();
    for (const e of expressions) {
      expressionIdSet.add(e.id);
      if (typeof e.data.id === "string") expressionIdSet.add(e.data.id);
    }
    console.log(`  expression_items: ${expressions.length} of ${exprSnap.size}`);

    // 4. Example sentences: referential closure over the sampled words + grammar.
    const exampleIds = new Set<string>();
    for (const w of words) {
      for (const id of (w.data.exampleIds as string[] | undefined) ?? []) exampleIds.add(id);
      for (const id of (w.data.appearsInIds as string[] | undefined) ?? []) exampleIds.add(id);
    }
    for (const g of grammarItems) {
      for (const id of (g.data.exampleIds as string[] | undefined) ?? []) exampleIds.add(id);
    }
    const exampleFetch = await fetchByIds(db.collection("example_sentences"), [...exampleIds]);
    const examples = exampleFetch.found;
    const exampleIdSet = new Set(examples.map((e) => e.id));
    if (exampleFetch.missing.length > 0) {
      console.warn(`  WARN: ${exampleFetch.missing.length} referenced example id(s) have no doc in prod (dangling; dropped)`);
    }
    console.log(`  example_sentences: ${examples.length}`);

    // 5. Strip OUTBOUND references to unsampled docs so the local set passes
    //    validate-invariant-all.ts (dangling refs would look like corruption).
    for (const w of words) {
      w.data.exampleIds = ((w.data.exampleIds as string[] | undefined) ?? []).filter((id) => exampleIdSet.has(id));
      w.data.appearsInIds = ((w.data.appearsInIds as string[] | undefined) ?? []).filter((id) => exampleIdSet.has(id));
    }
    for (const g of grammarItems) {
      if (Array.isArray(g.data.exampleIds)) {
        g.data.exampleIds = (g.data.exampleIds as string[]).filter((id) => exampleIdSet.has(id));
      }
      if (Array.isArray(g.data.words)) {
        g.data.words = (g.data.words as string[]).filter((id) => wordIdSet.has(id));
      }
    }
    for (const e of examples) {
      if (Array.isArray(e.data.appearsInGrammarIds)) {
        e.data.appearsInGrammarIds = (e.data.appearsInGrammarIds as string[]).filter((id) => grammarIdSet.has(id));
      }
      if (typeof e.data.ownerWordId === "string" && !wordIdSet.has(e.data.ownerWordId)) {
        delete e.data.ownerWordId;
      }
      if (Array.isArray(e.data.segments)) {
        for (const seg of e.data.segments as { id?: string }[]) {
          // Same treatment reconcileIncomingSegments gives dangling segment ids:
          // keep text/transliteration, drop the link.
          if (seg && typeof seg.id === "string" && !wordIdSet.has(seg.id)) delete seg.id;
        }
      }
    }

    // 6. Per-word / per-grammar satellite docs (composite ids; a missing entry is
    //    a known prod condition — index drift — so it is counted, not fatal).
    const wordIndexFetch = await fetchByIds(
      db.collection("word_index"),
      words.map((w) => `${lang}_${w.data.term as string}`)
    );
    if (wordIndexFetch.missing.length > 0) {
      console.warn(`  WARN: ${wordIndexFetch.missing.length} sampled word(s) have no word_index entry in prod`);
    }
    const progressDocs = (await fetchByIds(db.collection("progress"), sampledWordIds.map((id) => `${lang}_${id}`))).found;
    const flaggedDocs = (await fetchByIds(db.collection("flagged_words"), sampledWordIds.map((id) => `${lang}_${id}`))).found;
    const grammarProgressDocs = (
      await fetchByIds(db.collection("grammar_progress"), sampledGrammarIds.map((id) => `${lang}_${id}`))
    ).found;
    console.log(
      `  word_index: ${wordIndexFetch.found.length}, progress: ${progressDocs.length}, ` +
      `flagged_words: ${flaggedDocs.length}, grammar_progress: ${grammarProgressDocs.length}`
    );

    // 7. Groups: all group docs of the language (keeps ordering/category UI
    //    intact, empty groups included), membership intersected with the sample.
    const wordGroups = (await db.collection("word_groups").where("language", "==", lang).get()).docs.map((d) => {
      const data = d.data();
      data.wordIds = ((data.wordIds as string[] | undefined) ?? []).filter((id) => wordIdSet.has(id));
      return { id: d.id, data };
    });
    const grammarGroups = (await db.collection("grammar_groups").where("language", "==", lang).get()).docs.map((d) => {
      const data = d.data();
      data.grammarIds = ((data.grammarIds as string[] | undefined) ?? []).filter((id) => grammarIdSet.has(id));
      return { id: d.id, data };
    });
    const expressionGroups = (await db.collection("expression_groups").where("language", "==", iso).get()).docs.map((d) => {
      const data = d.data();
      data.expressionIds = ((data.expressionIds as string[] | undefined) ?? []).filter((id) => expressionIdSet.has(id));
      return { id: d.id, data };
    });
    console.log(
      `  word_groups: ${wordGroups.length}, grammar_groups: ${grammarGroups.length}, ` +
      `expression_groups: ${expressionGroups.length}`
    );

    // 8. id_maps verbatim — local smart-add keeps minting from the production
    //    counter, so new local ids can never collide with sampled ones.
    const idMaps = (await fetchByIds(db.collection("id_maps"), [lang, `example_sentences_${lang}`])).found;

    // 9. Language doc, with meta recomputed over the SAMPLE (mirrors
    //    updateLanguageMeta) — a 30-word set must not claim 2,000 words.
    const langDoc = languageDocs.find((d) => d.id === lang);
    const topicSet = new Set<string>();
    const levelSet = new Set<string>();
    for (const w of words) {
      for (const t of (w.data.topics as string[] | undefined) ?? []) topicSet.add(t);
      if (typeof w.data.level === "string" && w.data.level) levelSet.add(w.data.level);
    }
    add("languages", [{
      id: lang,
      data: {
        ...(langDoc?.data() ?? {}),
        wordCount: words.length,
        topics: [...topicSet],
        levels: [...levelSet].sort(),
      },
    }]);

    add("words", words);
    add("grammar_items", grammarItems);
    add("expression_items", expressions);
    add("example_sentences", examples);
    add("word_index", wordIndexFetch.found);
    add("progress", progressDocs);
    add("flagged_words", flaggedDocs);
    add("grammar_progress", grammarProgressDocs);
    add("word_groups", wordGroups);
    add("grammar_groups", grammarGroups);
    add("expression_groups", expressionGroups);
    add("id_maps", idMaps);

    perLanguage[lang] = {
      words: words.length,
      grammar_items: grammarItems.length,
      expression_items: expressions.length,
      example_sentences: examples.length,
    };
  }

  // Config docs (once): everything EXCEPT `auth` (its absence is what keeps the
  // local server's auth OFF) and `llm` (holds the API key — .env supplies it
  // locally, and a secret must not land in a JSON snapshot on disk).
  const configDocs = (await db.collection("config").get()).docs
    .filter((d) => d.id !== "auth" && d.id !== "llm")
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
  add("config", configDocs);
  console.log(`\nconfig: ${configDocs.map((d) => d.id).join(", ")} (auth/llm excluded)`);

  // Write the snapshot.
  await mkdir(OUT_DIR, { recursive: true });
  const counts: Record<string, number> = {};
  for (const [col, docs] of snapshot) {
    const sanitized = docs.map((d) => ({
      id: d.id,
      data: sanitizeValue(d.data, `${col}/${d.id}`, warnings) as Record<string, unknown>,
    }));
    await writeFile(resolve(OUT_DIR, `${col}.json`), JSON.stringify(sanitized, null, 2));
    counts[col] = sanitized.length;
  }
  await writeFile(
    resolve(OUT_DIR, "manifest.json"),
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        projectId: PROJECT_ID,
        databaseId: DATABASE_ID,
        args: { languages: targetLanguages, words: args.words, grammar: args.grammar, expressions: args.expressions },
        counts,
        perLanguage,
      },
      null,
      2
    )
  );

  for (const w of warnings) console.warn(`WARN: ${w}`);
  console.log(`\nSnapshot written to ${OUT_DIR}`);
  console.log(Object.entries(counts).map(([c, n]) => `  ${c}: ${n}`).join("\n"));
  console.log("\nNext: npm run seed:load   (loads the snapshot into the local emulator)");
}

main().catch((err) => {
  console.error("seed-download failed:", err);
  console.error("\nIf this is an auth/NOT_FOUND error, check `gcloud auth application-default login`");
  console.error(`and that FIRESTORE_PROJECT (${PROJECT_ID}) is the project holding ${DATABASE_ID}.`);
  process.exit(1);
});
