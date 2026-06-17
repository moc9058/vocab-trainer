/**
 * Wipe all grammar-related Firestore data. Use before deploying the new
 * statement/descriptions/groups schema — the legacy chapter/subchapter docs
 * are incompatible with the new shape.
 *
 * Wipes: grammar_items, grammar_chapters, grammar_progress,
 *        grammar_quiz_sessions, grammar_groups.
 */
import { Firestore } from "@google-cloud/firestore";

const COLLECTIONS = [
  "grammar_items",
  "grammar_chapters",
  "grammar_progress",
  "grammar_quiz_sessions",
  "grammar_groups",
];

const BATCH_LIMIT = 500;

async function wipeCollection(db: Firestore, name: string): Promise<number> {
  let totalDeleted = 0;
  while (true) {
    const snap = await db.collection(name).limit(BATCH_LIMIT).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    totalDeleted += snap.docs.length;
    console.log(`  ${name}: deleted ${snap.docs.length} (running total ${totalDeleted})`);
  }
  return totalDeleted;
}

async function main() {
  const db = new Firestore({
    databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
    ignoreUndefinedProperties: true,
  });

  console.log("Wiping grammar collections...");
  let grandTotal = 0;
  for (const name of COLLECTIONS) {
    const n = await wipeCollection(db, name);
    grandTotal += n;
    console.log(`${name}: ${n} doc(s) deleted`);
  }
  console.log(`Done. Total deleted: ${grandTotal}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
