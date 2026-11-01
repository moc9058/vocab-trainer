import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { MathManifest } from "./math-sync.js";

const chapterFilename = /^(\d+)\.\s+(.+)\.md$/;
export interface TextbookLayout {
  folder: string;
  bookId?: string;
  chapters: { file: string; chapterId?: string }[];
  missingFiles: string[];
  issues: string[];
}

// Shared by read-only authoring discovery and strict pre-publication validation.
export async function inspectTextbookLayout(
  root: string,
  manifest: MathManifest,
): Promise<TextbookLayout[]> {
  const folders = new Map<string, MathManifest["books"][number] | undefined>();
  const reports: TextbookLayout[] = [];
  for (const book of manifest.books) {
    const folder = book.chapters[0]?.file.split("/")[0];
    if (!folder || folder === "." || folder === ".." ||
        book.chapters.some((c) => !/^[^/]+\/md\/[^/]+$/.test(c.file) || c.file.split("/")[0] !== folder))
      throw new Error(`Invalid textbook layout for ${book.id}: use <book>/md/<number>. <title>.md`);
    if (folders.has(folder)) throw new Error(`Multiple books use textbook folder: ${folder}`);
    folders.set(folder, book);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const names = await readdir(resolve(root, entry.name));
    if (names.includes("md") || names.includes("MD")) {
      if (!folders.has(entry.name)) folders.set(entry.name, undefined);
    }
  }
  for (const [folder, book] of folders) {
    const report: TextbookLayout = { folder, bookId: book?.id, chapters: [], missingFiles: [], issues: [] };
    reports.push(report);
    if (!book) report.issues.push("Book is not registered in manifest.json");
    if (book?.curriculumFile && (!book.curriculumFile.startsWith(`${folder}/curriculum/`) || book.curriculumFile.split("/").includes("..")))
      report.issues.push("Curriculum must be outside md, under the book's curriculum/ directory");
    let entries;
    try {
      const names = await readdir(resolve(root, folder));
      if (names.includes("MD")) report.issues.push("Use lowercase md/ only; rename MD/ explicitly");
      if (!names.includes("md")) throw Object.assign(new Error("Missing md/"), { code: "ENOENT" });
      entries = await readdir(resolve(root, folder, "md"), { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      report.issues.push("Missing md/ directory");
      report.missingFiles = book?.chapters.map((c) => c.file) ?? [];
      continue;
    }
    const numbers = new Set<number>();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && entry.name === ".DS_Store") continue;
      const match = chapterFilename.exec(entry.name);
      if (!entry.isFile() || !match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1 || !match[2].trim()) {
        report.issues.push(`Not a chapter Markdown file: ${folder}/md/${entry.name}`);
        continue;
      }
      const number = Number(match[1]);
      if (numbers.has(number)) report.issues.push(`Duplicate chapter number ${number} in ${folder}/md/`);
      numbers.add(number);
      const file = `${folder}/md/${entry.name}`;
      const chapterId = book?.chapters.find((c) => c.file === file)?.id;
      report.chapters.push({ file, ...(chapterId ? { chapterId } : {}) });
      if (book && !chapterId) report.issues.push(`Unregistered chapter: ${file}`);
    }
    report.missingFiles = book?.chapters.filter((c) => !report.chapters.some((f) => f.file === c.file)).map((c) => c.file) ?? [];
    report.issues.push(...report.missingFiles.map((f) => `Missing chapter file: ${f}`));
    if (!report.chapters.length) report.issues.push("No chapter Markdown files found");
  }
  return reports;
}
