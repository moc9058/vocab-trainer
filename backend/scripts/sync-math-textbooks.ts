import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { prepareMathBooks } from "../src/math-sync.js";
import { mathHash } from "../src/math-core.js";
const args = process.argv.slice(2);
const environment = args.find((a) => a.startsWith("--target="))?.slice(9);
if (
  !["production", "emulator"].includes(environment ?? "") ||
  args.some(
    (a) =>
      a !== "--dry-run" &&
      !["--target=production", "--target=emulator"].includes(a),
  )
)
  throw new Error(
    "Usage: npm run math:sync -- --target=emulator|production [--dry-run]",
  );
if (environment === "emulator" && !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Emulator target requires FIRESTORE_EMULATOR_HOST");
if (environment === "production" && process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Production target conflicts with FIRESTORE_EMULATOR_HOST");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../textbook");
const prepared = await prepareMathBooks(
  root,
  JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")),
);
const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || "vocab-trainer-490014",
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});
try {
  for (const { book, sources } of prepared) {
    const ref = db.collection("math_books").doc(book.id);
    const old = await ref.get();
    // Missing local entries do not delete published chapters.
    const retained = (old.get("chapters") ?? []).filter(
      (c: { id: string }) => !book.chapters.some((n) => n.id === c.id),
    );
    book.chapters = [...book.chapters, ...retained].sort(
      (a, b) => a.number - b.number,
    );
    if (
      new Set(book.chapters.map((c) => c.number)).size !== book.chapters.length
    )
      throw new Error(
        "Chapter number conflicts with a retained published chapter",
      );
    const { revision: _revision, ...content } = book;
    book.revision = mathHash(JSON.stringify(content));
    const changed = sources.filter(
      (s) =>
        !(old.get("chapters") ?? []).some(
          (c: { versionId: string }) => c.versionId === s.versionId,
        ),
    );
    console.log(
      `${book.id}: ${changed.length} changed chapters; ${args.includes("--dry-run") ? "dry run" : "publish"}`,
    );
    if (args.includes("--dry-run") || old.get("revision") === book.revision)
      continue;
    for (const source of changed)
      await db
        .collection("math_chapter_versions")
        .doc(source.versionId)
        .set(source);
    await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (current.get("revision") !== old.get("revision"))
        throw new Error("Publication changed concurrently; run sync again");
      tx.set(ref, book);
    });
  }
} finally {
  await db.terminate();
}
