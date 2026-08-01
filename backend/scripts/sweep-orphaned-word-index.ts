/**
 * Sweep the `word_index` collection for entries that no longer match a real
 * word document, and repair or delete them.
 *
 * `word_index/{language}_{term}` is the lookup used by check-terms (the chip
 * "✓ exists" state) and by segment linking. An entry can drift out of sync
 * with the `words` collection in two ways:
 *
 *   - ORPHANED  — the referenced word id has no doc (or no word with that
 *                 term exists at all). The word was clobbered/deleted but its
 *                 index entry survived. Fix: delete the index entry.
 *   - MISLINKED — the referenced word doc exists but now holds a DIFFERENT
 *                 term (classic duplicate-ID collision: two words were handed
 *                 the same id, one overwrote the other's doc). Fix: if a word
 *                 with the index's term exists elsewhere, repoint the entry to
 *                 it; otherwise delete the entry.
 *
 * This is the bulk counterpart to `fix-word-index-entry.ts` (which repairs one
 * term and also rewrites mislinked example-sentence segments). This sweep only
 * touches `word_index`; run `fix-word-index-entry.ts --term=<t>` afterwards if
 * a reported term also needs its segment `seg.id` links corrected.
 *
 * Safe to re-run. Use `--dry-run` to preview.
 *
 * Usage:
 *   cd backend && npx tsx scripts/sweep-orphaned-word-index.ts [--language=chinese | --all] [--dry-run]
 */

// Must stay the FIRST import: it fixes the project for every Firestore client the
// process builds. Without it this script resolved to gcloud's default project,
// which has no `vocab-database`, and every query died with a bare `5 NOT_FOUND`.
import { PROJECT_ID, DATABASE_ID } from "./_project-env.js";
import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allLanguages = args.includes("--all");
const langArg = args.find((a) => a.startsWith("--language="));
const language = langArg ? langArg.split("=")[1] : "chinese";

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
  ignoreUndefinedProperties: true,
});

const wordIndex = db.collection("word_index");
const wordsCol = db.collection("words");

const MAX_BATCH = 400; // Firestore caps a WriteBatch at 500 ops.

interface WordInfo {
  id: string;
  transliteration: string;
  level: string;
}

async function sweepLanguage(lang: string): Promise<{ orphaned: number; mislinked: number; repaired: number; deleted: number }> {
  console.log(`\n=== Language "${lang}"${dryRun ? " (DRY RUN)" : ""} ===`);

  const [indexSnap, wordSnap] = await Promise.all([
    wordIndex.where("language", "==", lang).get(),
    wordsCol.where("language", "==", lang).get(),
  ]);

  // id -> term, for detecting orphaned/mislinked references.
  const termById = new Map<string, string>();
  // term -> word info, for repointing a mislinked entry to the correct word.
  // First writer wins on duplicate terms (homographs); we warn below.
  const wordByTerm = new Map<string, WordInfo>();
  const duplicateTerms = new Set<string>();

  for (const doc of wordSnap.docs) {
    const d = doc.data();
    const term = d.term as string;
    termById.set(doc.id, term);
    if (wordByTerm.has(term)) {
      duplicateTerms.add(term);
    } else {
      wordByTerm.set(term, {
        id: doc.id,
        transliteration: (d.transliteration ?? "") as string,
        level: (d.level ?? "") as string,
      });
    }
  }

  console.log(`  ${indexSnap.size} index entries, ${wordSnap.size} words.`);

  const repairs: Array<{ docId: string; term: string; fromId: string; to: WordInfo }> = [];
  const deletions: Array<{ docId: string; term: string; fromId: string; reason: string }> = [];

  for (const doc of indexSnap.docs) {
    const d = doc.data();
    const term = d.term as string;
    const id = d.id as string;

    const actualTerm = termById.get(id);
    if (actualTerm === term) continue; // healthy

    const correct = wordByTerm.get(term);
    if (correct) {
      // MISLINKED but the real word exists elsewhere → repoint.
      // (If it already points at the right id we'd have continued above.)
      repairs.push({ docId: doc.id, term, fromId: id, to: correct });
    } else if (actualTerm === undefined) {
      // ORPHANED — referenced doc missing and no word has this term.
      deletions.push({ docId: doc.id, term, fromId: id, reason: "word doc missing" });
    } else {
      // MISLINKED to a doc holding a different term, and no word has the
      // index's term → the term's word is truly gone.
      deletions.push({ docId: doc.id, term, fromId: id, reason: `points to word with term "${actualTerm}"` });
    }
  }

  const mislinkedCount = repairs.length + deletions.filter((x) => x.reason.startsWith("points to")).length;
  const orphanedCount = deletions.filter((x) => x.reason === "word doc missing").length;

  if (repairs.length === 0 && deletions.length === 0) {
    console.log("  ✓ No drift found.");
    return { orphaned: 0, mislinked: 0, repaired: 0, deleted: 0 };
  }

  if (duplicateTerms.size > 0) {
    console.log(`  ⚠ ${duplicateTerms.size} term(s) map to multiple words; repairs use the first by id.`);
  }

  const preview = (label: string, items: Array<{ docId: string; term: string; fromId: string }>, extra: (i: any) => string) => {
    if (items.length === 0) return;
    console.log(`  ${label}: ${items.length}`);
    for (const i of items.slice(0, 10)) {
      console.log(`    ${i.docId} (term="${i.term}") ${extra(i)}`);
    }
    if (items.length > 10) console.log(`    … and ${items.length - 10} more`);
  };

  preview("REPAIR (repoint to correct word)", repairs, (i) => `${i.fromId} -> ${i.to.id}`);
  preview("DELETE", deletions, (i) => `id=${i.fromId} (${i.reason})`);

  if (!dryRun) {
    let batch = db.batch();
    let ops = 0;
    const flush = async () => {
      if (ops > 0) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    };
    for (const r of repairs) {
      batch.set(wordIndex.doc(r.docId), {
        language: lang,
        term: r.term,
        id: r.to.id,
        transliteration: r.to.transliteration,
        level: r.to.level,
      });
      if (++ops >= MAX_BATCH) await flush();
    }
    for (const del of deletions) {
      batch.delete(wordIndex.doc(del.docId));
      if (++ops >= MAX_BATCH) await flush();
    }
    await flush();
    console.log(`  ✓ Applied: ${repairs.length} repaired, ${deletions.length} deleted.`);
  } else {
    console.log(`  [DRY RUN] Would repair ${repairs.length} and delete ${deletions.length}.`);
  }

  return {
    orphaned: orphanedCount,
    mislinked: mislinkedCount,
    repaired: dryRun ? 0 : repairs.length,
    deleted: dryRun ? 0 : deletions.length,
  };
}

async function main() {
  let languages: string[];
  if (allLanguages) {
    // Enumerate distinct languages present in word_index.
    const snap = await wordIndex.select("language").get();
    languages = [...new Set(snap.docs.map((d) => d.data().language as string).filter(Boolean))].sort();
    console.log(`Sweeping all languages: ${languages.join(", ") || "(none)"}`);
  } else {
    languages = [language];
  }

  const totals = { orphaned: 0, mislinked: 0, repaired: 0, deleted: 0 };
  for (const lang of languages) {
    const r = await sweepLanguage(lang);
    totals.orphaned += r.orphaned;
    totals.mislinked += r.mislinked;
    totals.repaired += r.repaired;
    totals.deleted += r.deleted;
  }

  console.log(
    `\n=== Done${dryRun ? " (DRY RUN — nothing written)" : ""} ===\n` +
      `  orphaned: ${totals.orphaned}, mislinked: ${totals.mislinked}` +
      (dryRun ? "" : `, repaired: ${totals.repaired}, deleted: ${totals.deleted}`),
  );
}

main().catch((e) => {
  console.error("Sweep failed:", e);
  process.exit(1);
});
