import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mathHash, sourceHeadings } from "../src/math-core.js";
import type { MathManifest } from "../src/math-sync.js";
import type { Curriculum } from "../src/math-types.js";
const root = fileURLToPath(new URL("../../textbook/", import.meta.url));
const manifest: MathManifest = JSON.parse(
  await readFile(resolve(root, "manifest.json"), "utf8"),
);
for (const book of manifest.books) {
  let prior: Curriculum | undefined;
  try {
    if (book.curriculumFile)
      prior = JSON.parse(
        await readFile(resolve(root, book.curriculumFile), "utf8"),
      );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const changes = [];
  for (const chapter of book.chapters) {
    const path = resolve(root, chapter.file);
    if (!path.startsWith(root)) throw new Error("Invalid chapter path");
    const source = await readFile(path, "utf8"),
      sha256 = mathHash(source);
    if (
      prior?.sources.find((s) => s.chapterId === chapter.id)?.sha256 !== sha256
    )
      changes.push({
        ...chapter,
        sha256,
        headings: sourceHeadings(source),
        existingObjectiveIds:
          prior?.objectives
            .filter((o) => o.chapterId === chapter.id)
            .map((o) => o.id) ?? [],
      });
  }
  console.log(
    JSON.stringify(
      {
        bookId: book.id,
        language: book.language,
        subjectProfile: book.subjectProfile,
        changes,
      },
      null,
      2,
    ),
  );
}
