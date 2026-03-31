/**
 * Migration script: uploads DB config and archive data to Firestore.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-db-config-to-firestore.ts [--prompts] [--archives]
 *
 *   --prompts   Migrate speaking&writing/ + translation/ config
 *   --archives  Migrate backup/ + original/ archive data
 *   (no flags)  Run both
 */

import { Firestore } from "@google-cloud/firestore";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "..", "DB");

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

const CHUNK_SIZE = 500;

// ========== Speaking & Writing Config ==========

async function migrateSpeakingWriting(): Promise<void> {
  console.log("\n--- Migrating speaking&writing config ---");
  const dir = resolve(DB_DIR, "speaking&writing");

  const outputSchema = JSON.parse(await readFile(resolve(dir, "output_schema.json"), "utf-8"));
  const useCases = JSON.parse(await readFile(resolve(dir, "use_cases.json"), "utf-8"));

  const prompts: Record<string, string> = {};
  for (const [code, file] of [["en", "english"], ["ja", "japanese"], ["ko", "korean"], ["zh", "chinese"]]) {
    prompts[code] = await readFile(resolve(dir, `system_prompt_${file}.md`), "utf-8");
  }

  await db.collection("config").doc("speaking_writing").set({
    outputSchema,
    useCases,
    prompts,
  });

  console.log("  Written to config/speaking_writing");
  console.log(`  Prompts: ${Object.keys(prompts).join(", ")}`);
  console.log(`  Use case modes: ${Object.keys(useCases).join(", ")}`);
}

// ========== Translation Config ==========

async function migrateTranslation(): Promise<void> {
  console.log("\n--- Migrating translation config ---");
  const dir = resolve(DB_DIR, "translation");

  const decomposeSchema = JSON.parse(await readFile(resolve(dir, "decompose_scheme.json"), "utf-8"));
  const translateSchema = JSON.parse(await readFile(resolve(dir, "output_scheme.json"), "utf-8"));

  const langPairs: [string, string][] = [["en", "english"], ["ja", "japanese"], ["ko", "korean"], ["zh", "chinese"]];

  const decomposePrompts: Record<string, string> = {};
  for (const [code, file] of langPairs) {
    decomposePrompts[code] = await readFile(resolve(dir, `system_prompt_decompose_${file}.md`), "utf-8");
  }

  const translatePrompts: Record<string, string> = {};
  for (const [code, file] of langPairs) {
    translatePrompts[code] = await readFile(resolve(dir, `system_prompt_translation_${file}.md`), "utf-8");
  }

  await db.collection("config").doc("translation").set({
    decomposeSchema,
    decomposePrompts,
    translateSchema,
    translatePrompts,
  });

  console.log("  Written to config/translation");
  console.log(`  Decompose prompts: ${Object.keys(decomposePrompts).join(", ")}`);
  console.log(`  Translate prompts: ${Object.keys(translatePrompts).join(", ")}`);
}

// ========== Vocabulary Config ==========

async function migrateVocabulary(): Promise<void> {
  console.log("\n--- Migrating vocabulary config ---");
  const dir = resolve(DB_DIR, "vocabulary");

  const smartAddSchema = JSON.parse(await readFile(resolve(dir, "smart_add_schema.json"), "utf-8"));
  const segmentSchema = JSON.parse(await readFile(resolve(dir, "segment_schema.json"), "utf-8"));

  const smartAddPrompts: Record<string, string> = {};
  const files = await readdir(dir);
  for (const file of files) {
    const match = file.match(/^smart_add_prompt_(.+)\.md$/);
    if (match) {
      smartAddPrompts[match[1]] = await readFile(resolve(dir, file), "utf-8");
    }
  }

  const segmentPrompt = await readFile(resolve(dir, "segment_prompt.md"), "utf-8");

  await db.collection("config").doc("vocabulary").set({
    smartAddSchema,
    smartAddPrompts,
    segmentSchema,
    segmentPrompt,
  });

  console.log("  Written to config/vocabulary");
  console.log(`  Smart-add prompts: ${Object.keys(smartAddPrompts).join(", ")}`);
  console.log(`  Schemas: smart_add, segment`);
}

// ========== Archive Helpers ==========

function stripEmptyKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripEmptyKeys);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "") continue;
      result[k] = stripEmptyKeys(v);
    }
    return result;
  }
  return obj;
}

async function writeChunked(
  collectionName: string,
  docId: string,
  source: string,
  items: unknown[],
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const cleaned = stripEmptyKeys(items) as unknown[];
  const chunkCount = Math.ceil(cleaned.length / CHUNK_SIZE) || 0;

  await db.collection(collectionName).doc(docId).set({
    source,
    totalItems: cleaned.length,
    chunkCount,
    migratedAt: new Date().toISOString(),
    ...metadata,
  });

  for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
    const chunk = cleaned.slice(i, i + CHUNK_SIZE);
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    await db.collection(collectionName).doc(docId).collection("chunks").doc(String(chunkIndex)).set({
      chunkIndex,
      items: chunk,
    });
    console.log(`    Chunk ${chunkIndex + 1}/${chunkCount}: ${chunk.length} items`);
  }
}

// ========== Backups ==========

async function migrateBackups(): Promise<void> {
  console.log("\n--- Migrating backup/ ---");
  const backupDir = resolve(DB_DIR, "backup");

  // Word backups (large JSON files)
  const entries = await readdir(backupDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

    const filePath = resolve(backupDir, entry.name);
    const fileSize = (await stat(filePath)).size;
    console.log(`  Processing ${entry.name} (${(fileSize / 1024 / 1024).toFixed(1)} MB)...`);

    const data = JSON.parse(await readFile(filePath, "utf-8"));
    const words = data.words ?? [];
    const docId = entry.name.replace(".json", "");

    await writeChunked("archive_backups", docId, `backup/${entry.name}`, words, {
      language: data.language ?? docId.split("_")[0],
    });

    console.log(`  Done: ${words.length} words in ${Math.ceil(words.length / CHUNK_SIZE)} chunks`);
  }

  // Grammar backups (small files in subdirectories)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const subDir = resolve(backupDir, entry.name);
    const files = await readdir(subDir);
    const grammarFiles: Record<string, unknown> = {};

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      grammarFiles[file.replace(".json", "")] = JSON.parse(await readFile(resolve(subDir, file), "utf-8"));
    }

    const docId = `${entry.name}_grammar`;
    await db.collection("archive_backups").doc(docId).set({
      source: `backup/${entry.name}/`,
      type: "grammar",
      files: grammarFiles,
      migratedAt: new Date().toISOString(),
    });

    console.log(`  Grammar backup ${entry.name}: ${Object.keys(grammarFiles).length} files`);
  }
}

// ========== Originals ==========

async function migrateOriginals(): Promise<void> {
  console.log("\n--- Migrating original/ ---");
  const originalDir = resolve(DB_DIR, "original");

  const dateFolders = await readdir(originalDir, { withFileTypes: true });
  for (const folder of dateFolders) {
    if (!folder.isDirectory()) continue;

    const folderPath = resolve(originalDir, folder.name);
    const files = await readdir(folderPath);
    console.log(`  Date folder: ${folder.name} (${files.length} files)`);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = resolve(folderPath, file);
      const fileSize = (await stat(filePath)).size;
      const docId = `${folder.name}_${file.replace(".json", "")}`;

      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw);

      // word_index.json has a different structure: { next_id, terms: {...} }
      if (file === "word_index.json") {
        const terms = data.terms ?? {};
        const termEntries = Object.entries(terms);
        console.log(`    ${file}: ${termEntries.length} terms (${(fileSize / 1024).toFixed(0)} KB)`);

        // Chunk the term entries
        const chunkCount = Math.ceil(termEntries.length / CHUNK_SIZE) || 0;
        await db.collection("archive_originals").doc(docId).set({
          source: `original/${folder.name}/${file}`,
          type: "word_index",
          nextId: data.next_id,
          totalTerms: termEntries.length,
          chunkCount,
          migratedAt: new Date().toISOString(),
        });

        for (let i = 0; i < termEntries.length; i += CHUNK_SIZE) {
          const chunk = Object.fromEntries(termEntries.slice(i, i + CHUNK_SIZE));
          const chunkIndex = Math.floor(i / CHUNK_SIZE);
          await db.collection("archive_originals").doc(docId).collection("chunks").doc(String(chunkIndex)).set({
            chunkIndex,
            terms: chunk,
          });
          console.log(`      Chunk ${chunkIndex + 1}/${chunkCount}`);
        }
        continue;
      }

      // Regular word files: { words: [...] }
      const words = data.words ?? [];
      if (words.length === 0) {
        // Empty stub
        await db.collection("archive_originals").doc(docId).set({
          source: `original/${folder.name}/${file}`,
          totalItems: 0,
          chunkCount: 0,
          migratedAt: new Date().toISOString(),
        });
        console.log(`    ${file}: empty stub`);
        continue;
      }

      console.log(`    ${file}: ${words.length} words (${(fileSize / 1024).toFixed(0)} KB)`);
      await writeChunked("archive_originals", docId, `original/${folder.name}/${file}`, words);
    }
  }
}

// ========== Main ==========

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runPrompts = args.length === 0 || args.includes("--prompts");
  const runArchives = args.length === 0 || args.includes("--archives");

  if (runPrompts) {
    await migrateSpeakingWriting();
    await migrateTranslation();
    await migrateVocabulary();
  }
  if (runArchives) {
    await migrateBackups();
    await migrateOriginals();
  }

  console.log("\nMigration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
