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
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { GrammarChapter, GrammarComponent } from "../src/types.js";

const GRAMMAR_DIR = resolve(import.meta.dirname, "..", "DB", "grammer");
const BACKUP_DIR = resolve(import.meta.dirname, "..", "DB", "backup");

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

const grammarChaptersCol = db.collection("grammar_chapters");
const grammarItemsCol = db.collection("grammar_items");

async function backupGrammar(): Promise<void> {
  console.log("\n--- Backing up current grammar from Firestore ---");
  const chapterSnap = await grammarChaptersCol.get();
  const itemSnap = await grammarItemsCol.get();

  if (chapterSnap.empty) {
    console.log("  No existing grammar to back up");
    return;
  }

  // Group chapters and items by language
  const chaptersByLang = new Map<string, FirebaseFirestore.DocumentData[]>();
  for (const doc of chapterSnap.docs) {
    const d = doc.data();
    const lang = d.language as string;
    if (!chaptersByLang.has(lang)) chaptersByLang.set(lang, []);
    chaptersByLang.get(lang)!.push(d);
  }

  const itemsByLangChapterSub = new Map<string, Map<number, Map<string, GrammarComponent[]>>>();
  for (const doc of itemSnap.docs) {
    const d = doc.data();
    const lang = d.language as string;
    const chNum = d.chapterNumber as number;
    const subId = d.subchapterId as string;

    if (!itemsByLangChapterSub.has(lang)) itemsByLangChapterSub.set(lang, new Map());
    const byChapter = itemsByLangChapterSub.get(lang)!;
    if (!byChapter.has(chNum)) byChapter.set(chNum, new Map());
    const bySub = byChapter.get(chNum)!;
    if (!bySub.has(subId)) bySub.set(subId, []);

    const comp: GrammarComponent = {
      id: doc.id,
      term: d.title,
      ...(d.description ? { description: d.description } : {}),
      ...(d.examples ? { examples: d.examples } : {}),
      ...(d.relatedWordIds ? { words: d.relatedWordIds } : {}),
      ...(d.level ? { level: d.level } : {}),
      ...(d.tags ? { tags: d.tags } : {}),
    };
    bySub.get(subId)!.push(comp);
  }

  for (const [language, chapters] of chaptersByLang) {
    const langBackupDir = join(BACKUP_DIR, language);
    await mkdir(langBackupDir, { recursive: true });

    for (const chData of chapters) {
      const chNum = chData.chapterNumber as number;
      const itemsByChapter = itemsByLangChapterSub.get(language)?.get(chNum) ?? new Map();

      const chapter: GrammarChapter = {
        chapter: chData.chapterTitle?.ja ?? `Chapter ${chNum}`,
        chapterNumber: chNum,
        chapterTitle: chData.chapterTitle,
        language,
        subchapters: (chData.subchapters ?? []).map((s: any) => ({
          id: s.id,
          title: s.title,
          components: itemsByChapter.get(s.id) ?? [],
        })),
      };

      const filename = `${chNum}. ${chData.chapterTitle?.ja ?? `Chapter ${chNum}`}.json`;
      const filepath = join(langBackupDir, filename);
      await writeFile(filepath, JSON.stringify(chapter, null, 2) + "\n", "utf-8");
      console.log(`  ${language}/${filename}`);
    }
  }
}

async function clearGrammarCollections(): Promise<void> {
  console.log("\n--- Clearing existing grammar data ---");
  for (const col of [grammarChaptersCol, grammarItemsCol]) {
    let deleted = 0;
    let snap = await col.limit(500).get();
    while (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      deleted += snap.size;
      snap = await col.limit(500).get();
    }
    console.log(`  Cleared: ${deleted} docs`);
  }
}

async function migrate() {
  // Back up current Firestore grammar before overwriting
  await backupGrammar();
  await clearGrammarCollections();

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
      await grammarChaptersCol.doc(chapterDocId).set({
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
            title: comp.term,
            description: comp.description,
            examples: comp.examples,
            ...(comp.words ? { relatedWordIds: comp.words } : {}),
            ...(comp.level ? { level: comp.level } : {}),
            ...(comp.tags ? { tags: comp.tags } : {}),
          };
          await grammarItemsCol.doc(comp.id).set(data);
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
