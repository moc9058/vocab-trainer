/**
 * Enforce "one word belongs to at most ONE category-A word group" over existing data.
 *
 * Group A is the lesson structure — a partition of the library, not overlapping
 * tags — but `word_groups.wordIds[]` was a plain set-add until now, so a word that
 * reappeared in a later lesson (very common when importing an article) stayed in
 * the older lesson's group as well.
 *
 * For every word that sits in two or more category-A groups this keeps the
 * membership in the group created MOST RECENTLY and strips it from the older ones,
 * which is what "the word moved to the new lesson" means. Ties on `createdAt` fall
 * back to `order`, then to the group id, so a re-run is deterministic.
 *
 * Category B is never touched: a B group is the not-yet-memorized subset drawn on
 * top of A, and several B groups may legitimately hold the same word.
 *
 * `firestore.ts:modifyWordGroupMembers` now enforces the same rule on every write,
 * so this is a one-time repair — but it is idempotent and safe to re-run (a second
 * run reports 0 duplicates).
 *
 * Usage:
 *   cd backend && npx tsx scripts/dedupe-word-group-membership.ts [options]
 *
 * Options:
 *   --dry-run          Report what would change without writing.
 *   --language=<lang>  Only this language (backend full name, e.g. "chinese").
 *   --all              Every language found in `word_groups` (default).
 */

// Must stay the FIRST import: it fixes the project for every Firestore client the
// process builds.
import { PROJECT_ID, DATABASE_ID } from "./_project-env.js";
import { Firestore } from "@google-cloud/firestore";

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  ignoreUndefinedProperties: true,
});

const wordGroups = db.collection("word_groups");

const MAX_BATCH = 400; // Firestore caps a WriteBatch at 500 ops.

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.find((a) => a.startsWith("--language="));
const onlyLanguage = langArg ? langArg.split("=")[1] : null;

interface GroupDoc {
  docId: string;
  id: string;
  language: string;
  name: string;
  wordIds: string[];
  createdAt: string;
  order?: number;
  category?: string;
}

/** Newest first — the survivor of a duplicate membership is `sorted[0]`. */
function byNewestFirst(a: GroupDoc, b: GroupDoc): number {
  const created = (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  if (created !== 0) return created;
  const order = (b.order ?? -1) - (a.order ?? -1);
  if (order !== 0) return order;
  return b.id.localeCompare(a.id);
}

async function main() {
  console.log(`Project ${PROJECT_ID} / database ${DATABASE_ID}${dryRun ? " (DRY RUN)" : ""}`);

  const snap = await wordGroups.get();
  const groups: GroupDoc[] = snap.docs
    .map((d) => {
      const data = d.data();
      return {
        docId: d.id,
        id: (data.id as string) ?? d.id,
        language: data.language as string,
        name: (data.name as string) ?? "(unnamed)",
        wordIds: (data.wordIds ?? []) as string[],
        createdAt: (data.createdAt as string) ?? "",
        order: typeof data.order === "number" ? (data.order as number) : undefined,
        category: data.category as string | undefined,
      };
    })
    // Absent category means A — only "B" is ever persisted.
    .filter((g) => g.category !== "B")
    .filter((g) => !onlyLanguage || g.language === onlyLanguage);

  if (groups.length === 0) {
    console.log(onlyLanguage ? `No category-A groups for "${onlyLanguage}".` : "No category-A groups.");
    return;
  }

  const byLanguage = new Map<string, GroupDoc[]>();
  for (const g of groups) {
    byLanguage.set(g.language, [...(byLanguage.get(g.language) ?? []), g]);
  }

  /** docId → the wordIds to strip from it. */
  const removals = new Map<string, Set<string>>();
  let totalDuplicateWords = 0;

  for (const [language, langGroups] of [...byLanguage.entries()].sort()) {
    const sorted = [...langGroups].sort(byNewestFirst);
    const holders = new Map<string, GroupDoc[]>();
    for (const g of sorted) {
      for (const wordId of g.wordIds) {
        holders.set(wordId, [...(holders.get(wordId) ?? []), g]);
      }
    }

    const duplicates = [...holders.entries()].filter(([, gs]) => gs.length > 1);
    console.log(
      `\n=== ${language} — ${langGroups.length} group(s), ` +
        `${holders.size} word(s), ${duplicates.length} in more than one group ===`
    );
    if (duplicates.length === 0) continue;
    totalDuplicateWords += duplicates.length;

    for (const [wordId, holdingGroups] of duplicates) {
      // `sorted` is newest-first and `holders` was built from it in that order, so
      // the survivor is simply the first entry.
      const [keep, ...drop] = holdingGroups;
      console.log(
        `  ${wordId}: keep "${keep.name}" (${keep.createdAt}) — ` +
          `drop from ${drop.map((g) => `"${g.name}"`).join(", ")}`
      );
      for (const g of drop) {
        const set = removals.get(g.docId) ?? new Set<string>();
        set.add(wordId);
        removals.set(g.docId, set);
      }
    }
  }

  if (removals.size === 0) {
    console.log("\nNothing to do — every word already belongs to at most one Group A group.");
    return;
  }

  const byDocId = new Map(groups.map((g) => [g.docId, g]));
  console.log(
    `\n${totalDuplicateWords} duplicated word(s) across ${removals.size} group document(s)` +
      `${dryRun ? " would be" : ""} repaired.`
  );
  if (dryRun) {
    console.log("DRY RUN — no writes made. Re-run without --dry-run to apply.");
    return;
  }

  let batch = db.batch();
  let ops = 0;
  for (const [docId, wordIdSet] of removals) {
    const group = byDocId.get(docId)!;
    batch.update(wordGroups.doc(docId), {
      wordIds: group.wordIds.filter((id) => !wordIdSet.has(id)),
    });
    if (++ops >= MAX_BATCH) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
