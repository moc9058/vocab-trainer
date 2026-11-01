import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mathHash, sourceHeadings } from "../src/math-core.js";
import { inspectTextbookLayout } from "../src/textbook-layout.js";
import type { MathManifest } from "../src/math-sync.js";
import type { Curriculum } from "../src/math-types.js";
const root = fileURLToPath(new URL("../../textbook/", import.meta.url));
const manifest: MathManifest = JSON.parse(
  await readFile(resolve(root, "manifest.json"), "utf8"),
);
for (const report of await inspectTextbookLayout(root, manifest)) {
  const book = manifest.books.find((b) => b.id === report.bookId);
  const curriculumFile = book?.curriculumFile ?? `${report.folder}/curriculum/learning-objectives.json`;
  if (!curriculumFile.startsWith(`${report.folder}/curriculum/`) || curriculumFile.split("/").includes(".."))
    throw new Error("Invalid curriculum path");
  let prior: Curriculum | undefined;
  try {
    prior = JSON.parse(await readFile(resolve(root, curriculumFile), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const changes = [];
  for (const chapter of report.chapters) {
    const source = await readFile(resolve(root, chapter.file), "utf8");
    const sha256 = mathHash(source);
    if (!chapter.chapterId || prior?.sources.find((s) => s.chapterId === chapter.chapterId)?.sha256 !== sha256)
      changes.push({
        ...chapter,
        status: chapter.chapterId ? "changed" : "unregistered",
        sha256,
        headings: sourceHeadings(source),
        existingObjectiveIds: chapter.chapterId
          ? prior?.objectives.filter((o) => o.chapterId === chapter.chapterId).map((o) => o.id) ?? []
          : [],
      });
  }
  console.log(JSON.stringify({
    ...report,
    status: book ? "registered" : "unregistered-book",
    language: book?.language,
    subjectProfile: book?.subjectProfile,
    curriculumFile,
    curriculumStatus: !prior ? "missing" : !book?.curriculumFile ? "unregistered" : "present",
    changes,
  }, null, 2));
}
