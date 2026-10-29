import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { mathHash, mathText } from "./math-core.js";
import { validateCurriculum, canonical } from "./math-curriculum.js";
import type {
  Curriculum,
  SubjectProfile,
  MathBook,
  MathSource,
} from "./math-types.js";
export interface MathManifest {
  books: {
    id: string;
    subjectId: string;
    subjectTitle: string;
    title: string;
    language: string;
    curriculumFile?: string;
    subjectProfile?: SubjectProfile;
    chapters: { id: string; file: string }[];
  }[];
}
export async function prepareMathBooks(
  root: string,
  manifest: MathManifest,
): Promise<
  { book: MathBook; sources: MathSource[]; curriculum?: Curriculum }[]
> {
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
    const directories = new Set(
      entry.chapters.map((c) => resolve(root, c.file, "..", "..")),
    );
    for (const directory of directories) {
      const names = await readdir(directory);
      if (names.includes("MD") && names.includes("md"))
        throw new Error("Both MD and md exist in one book");
    }
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
    let curriculum: Curriculum | undefined;
    if (entry.curriculumFile) {
      const path = resolve(root, entry.curriculumFile);
      if (relative(root, path).startsWith(".."))
        throw new Error("Invalid curriculum path");
      curriculum = validateCurriculum(
        JSON.parse(await readFile(path, "utf8")),
        entry.id,
        sources,
        entry.chapters,
        entry.language,
      );
      if (
        !entry.subjectProfile ||
        !["mathematics", "physics", "economics"].includes(
          entry.subjectProfile.subject,
        ) ||
        !mathText(entry.subjectProfile.version, 100) ||
        !Array.isArray(entry.subjectProfile.constraints) ||
        entry.subjectProfile.constraints.some((c) => !mathText(c, 4000))
      )
        throw new Error("Invalid subject profile");
    } else if (entry.subjectProfile)
      throw new Error("Curriculum required for subject profile");
    const revision = mathHash(
      canonical({
        ...metadata,
        ...(curriculum
          ? {
              curriculumRevision: curriculum.revision,
              subjectProfile: entry.subjectProfile,
            }
          : {}),
      }),
    );
    const book: MathBook = {
      ...metadata,
      revision,
      ...(curriculum
        ? {
            curriculumRevision: curriculum.revision,
            subjectProfile: entry.subjectProfile!,
            publicationId: revision,
          }
        : {}),
    };
    if (Buffer.byteLength(canonical(book)) > 800000)
      throw new Error("Publication exceeds 800KB");
    output.push({
      book,
      ...(curriculum ? { curriculum } : {}),
      sources,
    });
  }
  return output;
}
