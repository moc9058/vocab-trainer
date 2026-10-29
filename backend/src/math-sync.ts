import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { mathHash, mathText } from "./math-core.js";
import type { MathBook, MathSource } from "./math-types.js";
export interface MathManifest {
  books: {
    id: string;
    subjectId: string;
    subjectTitle: string;
    title: string;
    language: string;
    chapters: { id: string; file: string }[];
  }[];
}
export async function prepareMathBooks(
  root: string,
  manifest: MathManifest,
): Promise<{ book: MathBook; sources: MathSource[] }[]> {
  const seen = new Set<string>();
  const output = [];
  if (!manifest || !Array.isArray(manifest.books))
    throw new Error("Invalid textbook manifest");
  for (const entry of manifest.books) {
    if (
      !/^[\w-]{1,100}$/.test(entry.id) ||
      seen.has(entry.id) ||
      !mathText(entry.title, 1000) ||
      !mathText(entry.subjectId, 100) ||
      !mathText(entry.subjectTitle, 1000) ||
      !mathText(entry.language, 100)
    )
      throw new Error("Invalid book metadata");
    seen.add(entry.id);
    const ids = new Set<string>();
    const numbers = new Set<number>();
    const sources: MathSource[] = [];
    for (const chapter of entry.chapters) {
      const path = resolve(root, chapter.file);
      const rel = relative(root, path);
      if (
        rel.startsWith("..") ||
        !chapter.file.endsWith(".md") ||
        !/^[\w-]{1,100}$/.test(chapter.id) ||
        ids.has(chapter.id)
      )
        throw new Error("Invalid chapter path/ID");
      const match = path
        .split("/")
        .pop()!
        .match(/^(\d+)\.\s+(.+)\.md$/);
      if (!match || numbers.has(Number(match[1])))
        throw new Error("Chapter filenames need unique numeric prefixes");
      const markdown = await readFile(path, "utf8");
      if (!mathText(markdown, 250_000))
        throw new Error("Chapter is empty or exceeds 250KB");
      ids.add(chapter.id);
      numbers.add(Number(match[1]));
      const source = {
        id: chapter.id,
        number: Number(match[1]),
        title: match[2],
        markdown,
        bookId: entry.id,
      };
      sources.push({ ...source, versionId: mathHash(JSON.stringify(source)) });
    }
    sources.sort((a, b) => a.number - b.number);
    if (!sources.length) throw new Error("Book has no chapters");
    const chapters = sources.map(
      ({ markdown: _markdown, bookId: _bookId, ...chapter }) => chapter,
    );
    const metadata = {
      id: entry.id,
      subjectId: entry.subjectId,
      subjectTitle: entry.subjectTitle,
      title: entry.title,
      language: entry.language,
      chapters,
    };
    output.push({
      book: { ...metadata, revision: mathHash(JSON.stringify(metadata)) },
      sources,
    });
  }
  return output;
}
