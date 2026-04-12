/**
 * Deep invariant + completeness validator for word ↔ example_sentence data.
 *
 * Checks:
 *   1. Word ↔ example invariant: W.appearsInIds == W.exampleIds ∪ segRefs
 *   2. Dangling exampleIds entries: every id must point at an existing
 *      example sentence doc.
 *   3. Dangling appearsInIds entries: same.
 *   4. Dangling segment.id entries: every segment id must point at an
 *      existing word doc in the same language.
 *   5. Orphan example sentences: example docs not referenced by any word's
 *      exampleIds or appearsInIds.
 *   6. Orphan words: words with no references anywhere (empty exampleIds
 *      AND empty appearsInIds) — flagged but not deleted.
 *
 * Read-only — makes zero writes. Exit code 1 if any violation is found.
 */

import { Firestore } from "@google-cloud/firestore";

const db = new Firestore({
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
  ignoreUndefinedProperties: true,
});

interface Report {
  language: string;
  wordCount: number;
  exampleCount: number;
  violations: string[];
  warnings: string[];
  orphanWords: string[];
}

async function validateLanguage(language: string): Promise<Report> {
  const report: Report = {
    language,
    wordCount: 0,
    exampleCount: 0,
    violations: [],
    warnings: [],
    orphanWords: [],
  };

  const [wordSnap, exSnap] = await Promise.all([
    db.collection("words").where("language", "==", language).get(),
    db.collection("example_sentences").where("language", "==", language).get(),
  ]);
  report.wordCount = wordSnap.size;
  report.exampleCount = exSnap.size;

  const wordIds = new Set(wordSnap.docs.map((d) => d.id));
  const exIds = new Set(exSnap.docs.map((d) => d.id));

  // Precompute segment refs from examples.
  const segRefs = new Map<string, Set<string>>(); // wordId -> example IDs
  for (const doc of exSnap.docs) {
    const d = doc.data();
    const segs = (d.segments ?? []) as { id?: string }[];
    for (const seg of segs) {
      if (!seg.id) continue;
      if (!segRefs.has(seg.id)) segRefs.set(seg.id, new Set());
      segRefs.get(seg.id)!.add(doc.id);
      if (!wordIds.has(seg.id)) {
        report.violations.push(
          `dangling segment.id: example ${doc.id} references non-existent word ${seg.id}`,
        );
      }
    }
  }

  // Collect all example IDs referenced by any word (for orphan-example check).
  const allReferencedExIds = new Set<string>();

  // Walk words; check invariant + dangling IDs.
  for (const doc of wordSnap.docs) {
    const d = doc.data();
    const exampleIds = (d.exampleIds ?? []) as string[];
    const appearsInIds = (d.appearsInIds ?? []) as string[];

    for (const id of exampleIds) allReferencedExIds.add(id);
    for (const id of appearsInIds) allReferencedExIds.add(id);

    // Dangling exampleIds / appearsInIds
    for (const id of exampleIds) {
      if (!exIds.has(id)) {
        report.violations.push(
          `dangling exampleIds: word ${doc.id} (${d.term}) references non-existent example ${id}`,
        );
      }
    }
    for (const id of appearsInIds) {
      if (!exIds.has(id)) {
        report.violations.push(
          `dangling appearsInIds: word ${doc.id} (${d.term}) references non-existent example ${id}`,
        );
      }
    }

    // The invariant itself
    const want = new Set<string>(segRefs.get(doc.id) ?? []);
    for (const exId of exampleIds) want.add(exId);
    const have = new Set<string>(appearsInIds);
    const extra = [...have].filter((x) => !want.has(x));
    const missing = [...want].filter((x) => !have.has(x));
    if (extra.length > 0 || missing.length > 0) {
      report.violations.push(
        `invariant drift: word ${doc.id} (${d.term}) missing=[${missing.join(",")}] extra=[${extra.join(",")}]`,
      );
    }

    // Orphan words (no references anywhere)
    if (exampleIds.length === 0 && appearsInIds.length === 0) {
      report.orphanWords.push(`${doc.id} (${d.term})`);
    }
  }

  // Orphan examples: not referenced by any word's exampleIds or appearsInIds.
  for (const doc of exSnap.docs) {
    if (!allReferencedExIds.has(doc.id)) {
      report.violations.push(
        `orphan example: ${doc.id} is not referenced by any word`,
      );
    }
  }

  return report;
}

async function main() {
  const langSnap = await db.collection("languages").get();
  const languages = langSnap.docs.map((d) => d.id).filter((id) => !id.startsWith("_"));

  console.log(`Validating ${languages.length} language(s): ${languages.join(", ")}\n`);

  let totalViolations = 0;
  let totalWarnings = 0;
  let totalOrphans = 0;

  for (const lang of languages) {
    const report = await validateLanguage(lang);
    console.log(`=== ${lang} ===`);
    console.log(`  words: ${report.wordCount}, examples: ${report.exampleCount}`);
    console.log(`  violations: ${report.violations.length}`);
    if (report.violations.length > 0) {
      for (const v of report.violations.slice(0, 20)) console.log(`    - ${v}`);
      if (report.violations.length > 20) {
        console.log(`    ... and ${report.violations.length - 20} more`);
      }
    }
    console.log(`  warnings: ${report.warnings.length}`);
    if (report.warnings.length > 0) {
      for (const v of report.warnings.slice(0, 5)) console.log(`    - ${v}`);
      if (report.warnings.length > 5) {
        console.log(`    ... and ${report.warnings.length - 5} more`);
      }
    }
    if (report.orphanWords.length > 0) {
      console.log(`  orphan words (no references): ${report.orphanWords.length}`);
      for (const w of report.orphanWords.slice(0, 10)) console.log(`    - ${w}`);
    }
    console.log();
    totalViolations += report.violations.length;
    totalWarnings += report.warnings.length;
    totalOrphans += report.orphanWords.length;
  }

  console.log(`Total violations: ${totalViolations}`);
  console.log(`Total warnings: ${totalWarnings}`);
  console.log(`Total orphan words: ${totalOrphans}`);
  if (totalViolations > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Validator crashed:", e);
  process.exit(1);
});
