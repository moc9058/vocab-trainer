import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { prepareMathBooks } from "../src/math-sync.js";
import { publishMathBook } from "../src/math-publication.js";
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
if (prepared.some((p) => !p.curriculum))
  throw new Error(
    "Curriculum is required for textbook publication; run textbook:prepare and author the missing catalog first",
  );
const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || "vocab-trainer-490014",
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});
try {
  for (const { book, sources, curriculum } of prepared)
    await publishMathBook(
      db,
      book,
      sources,
      curriculum,
      args.includes("--dry-run"),
    );
} finally {
  await db.terminate();
}
