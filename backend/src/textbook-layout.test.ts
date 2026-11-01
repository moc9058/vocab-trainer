import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectTextbookLayout } from "./textbook-layout.js";
import { prepareMathBooks } from "./math-sync.js";

test("common layout discovers new subjects and rejects incomplete or non-chapter publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "textbook-layout-"));
  const manifest = { books: [{ id: "physics", subjectId: "physics", subjectTitle: "Physics", title: "Physics", language: "en", chapters: [{ id: "motion", file: "Physics/md/1. Motion.md" }] }] };
  try {
    await mkdir(join(root, "Physics/md"), { recursive: true });
    await writeFile(join(root, "Physics/md/1. Motion.md"), "# Motion\n");
    await writeFile(join(root, "Physics/md/.DS_Store"), "ignored");
    assert.equal((await prepareMathBooks(root, manifest))[0].sources[0].id, "motion");
    await mkdir(join(root, "Economics/md"), { recursive: true });
    await writeFile(join(root, "Economics/md/1. Markets.md"), "# Markets\n");
    const discovery = await inspectTextbookLayout(root, manifest);
    assert.equal(discovery.find((b) => b.folder === "Economics")?.chapters[0].chapterId, undefined);
    await assert.rejects(() => prepareMathBooks(root, manifest), /not registered/);
    await rm(join(root, "Economics"), { recursive: true });
    for (const [name, expected] of [
      ["README.md", /Not a chapter/],
      ["image.png", /Not a chapter/],
      ["2. Added.md", /Unregistered chapter/],
      ["1. Duplicate.md", /Duplicate chapter number/],
    ] as const) {
      await writeFile(join(root, "Physics/md", name), "# Text\n");
      await assert.rejects(() => prepareMathBooks(root, manifest), expected);
      await rm(join(root, "Physics/md", name));
    }
    await mkdir(join(root, "Physics/md/nested"));
    await assert.rejects(() => prepareMathBooks(root, manifest), /Not a chapter/);
    await rm(join(root, "Physics/md/nested"), { recursive: true });
    await rm(join(root, "Physics/md/1. Motion.md"));
    const missing = await inspectTextbookLayout(root, manifest);
    assert.deepEqual(missing[0].missingFiles, ["Physics/md/1. Motion.md"]);
    await assert.rejects(() => prepareMathBooks(root, manifest), /Missing chapter file/);
    const invalid = structuredClone(manifest);
    invalid.books[0].chapters[0].file = "Physics/MD/1. Motion.md";
    await assert.rejects(() => prepareMathBooks(root, invalid), /use <book>\/md/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
