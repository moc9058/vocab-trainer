/**
 * Rewrite legacy `word_groups.order` so the NEWEST group ranks first.
 *
 * `order` used to be a display order: `createWordGroup` appended each new group at
 * the end, and the first drag backfilled a complete 0..n-1 in that same sequence. It
 * now means PRIORITY (`firestore.ts:compareWordGroups`) — index 0 is the highest, and
 * the top category-A group is both the default target for every "add a word" flow
 * (`frontend/src/types.ts:defaultWordGroup`) and where `POST /groups/normalize` files
 * ungrouped words. Left alone, a pre-existing language would hand all of that to its
 * OLDEST group, which is the exact opposite of the intended default.
 *
 * Only rewrites a language whose current order is EXACTLY ascending by `createdAt`,
 * within each category — proof that the sequence is the old append artifact and not
 * something a user arranged on purpose. A language that was genuinely dragged is left
 * untouched, and so is one with no `order` at all (the `createdAt` fallback already
 * reads newest-first).
 *
 * Categories are ranked as blocks — every A group, then every B group, each newest
 * first — so the existing A-before-B shape survives. Only the relative order WITHIN
 * category A is load-bearing; B's order is cosmetic.
 *
 * Idempotent: after a run the sequence is descending, so the guard no longer matches
 * and a re-run reports 0.
 *
 * Usage:
 *   cd backend && npx tsx scripts/reprioritize-word-groups-newest-first.ts [options]
 *
 * Options:
 *   --dry-run          Report what would change without writing.
 *   --language=<lang>  Only this language (backend full name, e.g. "chinese").
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
  language: string;
  name: string;
  createdAt: string;
  order?: number;
  category?: string;
}

/** "A" is the absent-field default, mirroring `docToWordGroup`. */
function categoryOf(g: GroupDoc): "A" | "B" {
  return g.category === "B" ? "B" : "A";
}

/** The order the app currently reads: by `order`, `createdAt` ascending as the tiebreak. */
function byStoredOrder(a: GroupDoc, b: GroupDoc): number {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.order ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
}

function byNewestFirst(a: GroupDoc, b: GroupDoc): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
}

async function main() {
  console.log(`Project ${PROJECT_ID} / database ${DATABASE_ID}${dryRun ? " (DRY RUN)" : ""}`);

  const snap = await wordGroups.get();
  const byLanguage = new Map<string, GroupDoc[]>();
  for (const d of snap.docs) {
    const data = d.data();
    const language = data.language as string;
    if (!language) continue;
    if (onlyLanguage && language !== onlyLanguage) continue;
    const list = byLanguage.get(language) ?? [];
    list.push({
      docId: d.id,
      language,
      name: (data.name as string) ?? "",
      createdAt: (data.createdAt as string) ?? "",
      order: typeof data.order === "number" ? data.order : undefined,
      category: data.category as string | undefined,
    });
    byLanguage.set(language, list);
  }

  const writes: { docId: string; order: number }[] = [];

  for (const [language, groups] of [...byLanguage].sort()) {
    if (!groups.some((g) => g.order !== undefined)) {
      console.log(`  ${language}: no stored order — already newest-first by fallback, skipping`);
      continue;
    }

    // Guard: only touch a sequence that is the old append artifact. Checked per
    // category, since A and B were appended into one shared counter.
    const stored = [...groups].sort(byStoredOrder);
    const looksLegacy = (["A", "B"] as const).every((cat) => {
      const inCat = stored.filter((g) => categoryOf(g) === cat);
      return inCat.every(
        (g, i) => i === 0 || (inCat[i - 1].createdAt ?? "") <= (g.createdAt ?? "")
      );
    });
    if (!looksLegacy) {
      console.log(`  ${language}: order is not plain creation order — deliberate, leaving alone`);
      continue;
    }

    // A block then B block, each newest first.
    const ranked = [
      ...groups.filter((g) => categoryOf(g) === "A").sort(byNewestFirst),
      ...groups.filter((g) => categoryOf(g) === "B").sort(byNewestFirst),
    ];
    const changed = ranked.filter((g, i) => g.order !== i);
    if (changed.length === 0) {
      console.log(`  ${language}: already newest-first`);
      continue;
    }

    console.log(`  ${language}: ${changed.length} group(s) re-ranked`);
    ranked.forEach((g, i) => {
      if (g.order !== i) console.log(`      ${g.order} -> ${i}  ${categoryOf(g)}  ${g.name}`);
      writes.push({ docId: g.docId, order: i });
    });
  }

  if (writes.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (dryRun) {
    console.log(`DRY RUN — would write ${writes.length} group order(s).`);
    return;
  }

  let batch = db.batch();
  let ops = 0;
  for (const w of writes) {
    batch.update(wordGroups.doc(w.docId), { order: w.order });
    if (++ops >= MAX_BATCH) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  console.log(`Wrote ${writes.length} group order(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
