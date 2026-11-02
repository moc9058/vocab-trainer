/** Dry-run by default. Explicit --target=emulator|production; --apply writes after backing up. */
import "./_project-env.js";
import { Firestore, FieldPath, FieldValue, Timestamp, GeoPoint, DocumentReference } from "@google-cloud/firestore";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RETIRED_WORD_COLLECTIONS, cleanRetiredWordData } from "../src/retired-word-data.js";

// Preserve Firestore types in the backup so original field values can be reconstructed.
function encode(value: unknown): unknown {
  if (value instanceof Timestamp) return { $type: "timestamp", seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof GeoPoint) return { $type: "geopoint", latitude: value.latitude, longitude: value.longitude };
  if (value instanceof DocumentReference) return { $type: "reference", path: value.path };
  if (Buffer.isBuffer(value)) return { $type: "bytes", base64: value.toString("base64") };
  if (value instanceof Date) return { $type: "date", iso: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--apply", "--dry-run", "--target=production", "--target=emulator"].includes(arg))) throw new Error("Unknown argument");
  const targets = args.filter(arg => arg.startsWith("--target="));
  if (targets.length !== 1) throw new Error("Specify exactly one --target=emulator or --target=production");
  const emulator = targets[0] === "--target=emulator";
  if (emulator !== !!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Target and FIRESTORE_EMULATOR_HOST disagree");
  const apply = args.includes("--apply");
  if (apply && args.includes("--dry-run")) throw new Error("Choose --apply or --dry-run");
  const db = new Firestore({ projectId: process.env.FIRESTORE_PROJECT, databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database" });
  const backupDir = resolve(import.meta.dirname, "../data/retired-word-data");
  if (apply) await mkdir(backupDir, { recursive: true });
  const backupPath = resolve(backupDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${emulator ? "emulator" : "production"}.jsonl`);
  const backup = apply ? await open(backupPath, "wx", 0o600) : null;
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", target: emulator ? "emulator" : "production", project: process.env.FIRESTORE_PROJECT, database: db.databaseId, ...(apply ? { backupPath } : {}) }));
  try {
    for (const collection of RETIRED_WORD_COLLECTIONS) {
      let cursor: string | undefined;
      let scanned = 0, changed = 0;
      for (;;) {
        let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(200);
        if (cursor) query = query.startAfter(cursor);
        const snap = await query.get();
        if (snap.empty) break;
        const batch = db.batch();
        let writes = 0;
        for (const doc of snap.docs) {
          scanned++;
          const before = doc.data();
          const after = cleanRetiredWordData(collection, before);
          if (isDeepStrictEqual(before, after)) continue;
          changed++;
          if (!apply) continue;
          await backup!.write(JSON.stringify({ path: doc.ref.path, updateTime: encode(doc.updateTime), data: encode(before) }) + "\n");
          if (after === null) batch.delete(doc.ref, { lastUpdateTime: doc.updateTime });
          else {
            const patch: Record<string, unknown> = {};
            for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
              if (!isDeepStrictEqual(before[key], after[key])) patch[key] = key in after ? after[key] : FieldValue.delete();
            }
            batch.update(doc.ref, patch, { lastUpdateTime: doc.updateTime });
          }
          writes++;
        }
        if (writes) {
          // Durable local backup MUST precede any cloud mutation. Concurrent edits fail
          // the batch precondition; rerunning safely scans the remaining retired fields.
          await backup!.sync();
          await batch.commit();
        }
        cursor = snap.docs.at(-1)!.id;
      }
      console.log(JSON.stringify({ collection, scanned, changed }));
    }
  } finally {
    await backup?.close();
    await db.terminate();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
