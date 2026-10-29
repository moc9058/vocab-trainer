import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMathBooks, type MathManifest } from "../src/math-sync.js";
import {
  curriculumRevision,
  curriculumReadingView,
} from "../src/math-curriculum.js";
import type { Curriculum } from "../src/math-types.js";
const root = fileURLToPath(new URL("../../textbook/", import.meta.url));
const manifest: MathManifest = JSON.parse(
  await readFile(resolve(root, "manifest.json"), "utf8"),
);
if (process.argv.slice(2).some((a) => a !== "--write"))
  throw new Error("Usage: textbook:validate [--write]");
if (process.argv.includes("--write")) {
  // Validate in memory before writing either the catalog or its reading view.
  const updates = [];
  for (const book of manifest.books) {
    if (!book.curriculumFile) throw new Error(`Missing curriculum: ${book.id}`);
    const path = resolve(root, book.curriculumFile);
    if (!path.startsWith(root)) throw new Error("Invalid curriculum path");
    const c: Curriculum = JSON.parse(await readFile(path, "utf8"));
    c.revision = curriculumRevision(c);
    updates.push({ path, c });
  }
  // Revision-only normalization is checked through the same full validator.
  const { validateCurriculum } = await import("../src/math-curriculum.js");
  const legacy = structuredClone(manifest);
  legacy.books.forEach((b) => {
    delete b.curriculumFile;
    delete b.subjectProfile;
  });
  const prepared = await prepareMathBooks(root, legacy);
  for (const [i, u] of updates.entries())
    validateCurriculum(
      u.c,
      manifest.books[i].id,
      prepared[i].sources,
      manifest.books[i].chapters,
      manifest.books[i].language,
    );
  for (const { path, c } of updates) {
    await writeFile(path, JSON.stringify(c, null, 2) + "\n");
    await writeFile(resolve(path, "../README.md"), curriculumReadingView(c));
  }
}
for (const { book, curriculum } of await prepareMathBooks(root, manifest)) {
  if (!curriculum) throw new Error(`Missing curriculum: ${book.id}`);
  const path = resolve(
    root,
    manifest.books.find((b) => b.id === book.id)!.curriculumFile!,
    "../README.md",
  );
  if ((await readFile(path, "utf8")) !== curriculumReadingView(curriculum))
    throw new Error(`Stale reading view: ${book.id}; run with --write`);
  console.log(
    `${book.id}: ${book.chapters.length} chapters, ${curriculum.objectives.length} objectives, publication ${book.publicationId}`,
  );
}
