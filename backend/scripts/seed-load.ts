/**
 * seed-load: load the backend/data/local-seed/ snapshot into the local Firestore
 * EMULATOR (wiping it first).
 *
 * Usage:
 *   docker compose up -d firestore
 *   cd backend && npm run seed:load
 *
 * This script can physically never touch production: FIRESTORE_EMULATOR_HOST is
 * FORCED below before any client exists, so every read and write goes to the
 * emulator. (Assigning before the dotenv call also outranks .env — dotenv never
 * overrides an already-set variable.)
 */
process.env.FIRESTORE_EMULATOR_HOST ||= "localhost:8080";

// Keeps FIRESTORE_PROJECT consistent with dev-local.ts and docker-compose.yml —
// the emulator namespaces data by project id, so all three must agree.
import "./_project-env.js";
import { Firestore } from "@google-cloud/firestore";
import { config } from "dotenv";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(__dirname, "../../.env") });

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST!;
const PROJECT_ID = process.env.FIRESTORE_PROJECT || "vocab-trainer-490014";
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "vocab-database";

const SEED_DIR = resolve(__dirname, "..", "data", "local-seed");
const BATCH_SIZE = 500;

type SnapshotDoc = { id: string; data: Record<string, unknown> };

async function main(): Promise<void> {
  // Preflight: a clear message beats the opaque gRPC error the client throws
  // against a dead port.
  try {
    await fetch(`http://${EMULATOR_HOST}/`);
  } catch {
    console.error(`Firestore emulator is not running at ${EMULATOR_HOST}.`);
    console.error("Start it with: docker compose up -d firestore");
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log(`seed-load — writing to the local EMULATOR at ${EMULATOR_HOST}`);
  console.log(`  project:  ${PROJECT_ID}  database: ${DATABASE_ID}`);
  console.log("=".repeat(70));

  let files: string[];
  try {
    files = (await readdir(SEED_DIR)).filter((f) => f.endsWith(".json") && f !== "manifest.json");
  } catch {
    console.error(`No snapshot found at ${SEED_DIR}.`);
    console.error("Create one first: npm run seed:download");
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`Snapshot directory ${SEED_DIR} is empty. Run: npm run seed:download`);
    process.exit(1);
  }

  const db = new Firestore({
    projectId: PROJECT_ID,
    databaseId: DATABASE_ID,
    ignoreUndefinedProperties: true,
  });

  // Wipe: the snapshot is the source of truth, so a load is always a full
  // replace — leftovers from a previous seed would masquerade as real data.
  const existing = await db.listCollections();
  for (const col of existing) {
    await db.recursiveDelete(col);
  }
  if (existing.length > 0) {
    console.log(`Wiped ${existing.length} existing collection(s): ${existing.map((c) => c.id).join(", ")}`);
  }

  // Load every collection file, preserving doc ids.
  const counts: Record<string, number> = {};
  const exampleDocs: SnapshotDoc[] = [];
  for (const file of files.sort()) {
    const collection = file.replace(/\.json$/, "");
    const docs: SnapshotDoc[] = JSON.parse(await readFile(resolve(SEED_DIR, file), "utf-8"));
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const doc of docs.slice(i, i + BATCH_SIZE)) {
        batch.set(db.collection(collection).doc(doc.id), doc.data);
      }
      await batch.commit();
    }
    counts[collection] = docs.length;
    if (collection === "example_sentences") exampleDocs.push(...docs);
  }

  // Recompute example_sentence_index instead of snapshotting it: the index is
  // pure derived data (id = `${language}_${sha256(sentence).slice(0,16)}`,
  // mirroring firestore.ts:exampleSentenceIndexId).
  for (let i = 0; i < exampleDocs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const doc of exampleDocs.slice(i, i + BATCH_SIZE)) {
      const language = doc.data.language as string;
      const sentence = doc.data.sentence as string;
      if (!language || typeof sentence !== "string") continue;
      const hash = createHash("sha256").update(sentence).digest("hex").slice(0, 16);
      batch.set(db.collection("example_sentence_index").doc(`${language}_${hash}`), { exampleId: doc.id });
    }
    await batch.commit();
  }
  counts["example_sentence_index"] = exampleDocs.length;

  // Read-back canary: this is where a named-database ("vocab-database") gap in
  // the emulator would surface — writes accepted into one namespace, reads
  // served from another.
  const wordsFile: SnapshotDoc[] = JSON.parse(
    await readFile(resolve(SEED_DIR, "words.json"), "utf-8").catch(() => "[]")
  );
  if (wordsFile.length > 0) {
    const canary = await db.collection("words").doc(wordsFile[0].id).get();
    if (!canary.exists) {
      console.error(`Read-back check FAILED: words/${wordsFile[0].id} was written but cannot be read.`);
      console.error("This suggests the emulator does not serve the named database " + `"${DATABASE_ID}".`);
      console.error('Fallback: set FIRESTORE_DATABASE_ID="(default)" for seed:load, dev:local AND docker compose.');
      process.exit(1);
    }
  }

  console.log("\nLoaded:");
  console.log(Object.entries(counts).map(([c, n]) => `  ${c}: ${n}`).join("\n"));
  console.log("\nNext: npm run dev:local   (starts the API server against the emulator)");
  console.log("Note: emulator data is in-memory — after the firestore container restarts, re-run seed:load.");
}

main().catch((err) => {
  console.error("seed-load failed:", err);
  process.exit(1);
});
