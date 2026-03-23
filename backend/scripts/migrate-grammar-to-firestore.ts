/**
 * Migration script: imports grammar JSON data into Firestore.
 *
 * Reads the 6 chapter JSON files from backend/DB/grammer/chinese/,
 * flattens the chapter > subchapter > component hierarchy,
 * and writes to grammar_items and grammar_chapters collections.
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-grammar-to-firestore.ts
 */

import { Firestore } from "@google-cloud/firestore";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { GrammarChapter } from "../src/types.js";

const GRAMMAR_DIR = resolve(import.meta.dirname, "..", "DB", "grammer");

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const grammarChapters = db.collection("grammar_chapters");
const grammarItems = db.collection("grammar_items");

async function migrate() {
  // Find all language folders
  const languageDirs = await readdir(GRAMMAR_DIR, { withFileTypes: true });

  for (const dir of languageDirs) {
    if (!dir.isDirectory()) continue;
    const language = dir.name;
    const langDir = join(GRAMMAR_DIR, language);
    const files = await readdir(langDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    console.log(`\nProcessing language: ${language} (${jsonFiles.length} files)`);

    let totalItems = 0;

    for (const filename of jsonFiles) {
      const filepath = join(langDir, filename);
      const raw = await readFile(filepath, "utf-8");
      const chapter: GrammarChapter = JSON.parse(raw);

      // Write chapter metadata (including subchapter details)
      const chapterDocId = `${language}_${chapter.chapterNumber}`;
      await grammarChapters.doc(chapterDocId).set({
        language,
        chapterNumber: chapter.chapterNumber,
        chapterTitle: chapter.chapterTitle,
        subchapterCount: chapter.subchapters.length,
        subchapters: chapter.subchapters.map((s) => ({ id: s.id, title: s.title })),
      });
      console.log(`  Chapter ${chapter.chapterNumber}: ${chapter.chapter} (${chapter.subchapters.length} subchapters)`);

      // Write flattened grammar items
      for (const sub of chapter.subchapters) {
        for (const comp of sub.components) {
          const data = {
            language,
            chapterNumber: chapter.chapterNumber,
            subchapterId: sub.id,
            subchapterTitle: sub.title,
            title: comp.title,
            description: comp.description,
            examples: comp.examples,
            ...(comp.relatedWordIds ? { relatedWordIds: comp.relatedWordIds } : {}),
            ...(comp.level ? { level: comp.level } : {}),
            ...(comp.tags ? { tags: comp.tags } : {}),
          };
          await grammarItems.doc(comp.id).set(data);
          totalItems++;
        }
      }
    }

    console.log(`  Total grammar items migrated: ${totalItems}`);
  }

  console.log("\nMigration complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
