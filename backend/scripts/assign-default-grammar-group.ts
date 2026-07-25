/**
 * One-off migration: assign every pre-existing grammar item, per language, to a
 * group named "Group 1". Idempotent — reuses an existing "Group 1" group for a
 * language if one is already there instead of creating a duplicate.
 *
 * Usage:
 *   cd backend && npx tsx scripts/assign-default-grammar-group.ts [options]
 *
 * Options:
 *   --dry-run            Don't write to Firestore — just log what would change.
 *   --language=<code>    Only process this language (e.g. chinese, japanese, korean).
 */

import { Firestore } from "@google-cloud/firestore";

const db = new Firestore({
  projectId: process.env.FIRESTORE_PROJECT || undefined,
  databaseId: process.env.FIRESTORE_DATABASE_ID || "vocab-database",
});

const grammarItems = db.collection("grammar_items");
const grammarGroups = db.collection("grammar_groups");

const GROUP_NAME = "Group 1";

interface CliArgs {
  dryRun: boolean;
  language: string | null;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { dryRun: false, language: null };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--language=")) args.language = arg.slice("--language=".length);
    else console.warn(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs();
  console.log("Assign default grammar group");
  console.log(`  dry-run: ${args.dryRun}`);
  console.log(`  language: ${args.language ?? "<all>"}`);

  let itemQuery: FirebaseFirestore.Query = grammarItems;
  if (args.language) itemQuery = itemQuery.where("language", "==", args.language);
  const itemSnap = await itemQuery.select("language").get();

  const idsByLanguage = new Map<string, string[]>();
  for (const doc of itemSnap.docs) {
    const language = (doc.data().language as string | undefined) ?? "";
    if (!language) continue;
    if (!idsByLanguage.has(language)) idsByLanguage.set(language, []);
    idsByLanguage.get(language)!.push(doc.id);
  }

  console.log(`Found ${itemSnap.size} grammar item(s) across ${idsByLanguage.size} language(s)`);

  for (const [language, ids] of idsByLanguage) {
    console.log(`\n[${language}] ${ids.length} grammar item(s)`);

    const existingSnap = await grammarGroups
      .where("language", "==", language)
      .where("name", "==", GROUP_NAME)
      .get();

    const existingDoc = existingSnap.empty ? null : existingSnap.docs[0];
    const groupDocId =
      existingDoc?.id ?? `${language}_${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const currentIds: string[] = existingDoc ? (existingDoc.data().grammarIds as string[]) ?? [] : [];

    if (existingDoc) {
      console.log(`  Found existing "${GROUP_NAME}" (${groupDocId}) with ${currentIds.length} member(s)`);
    } else {
      console.log(`  No existing "${GROUP_NAME}" group — will create ${groupDocId}`);
    }

    const merged = new Set(currentIds);
    for (const id of ids) merged.add(id);
    const added = merged.size - currentIds.length;

    if (args.dryRun) {
      console.log(`  Would add ${added} new member(s) (total ${merged.size})`);
      continue;
    }

    if (existingDoc) {
      await grammarGroups.doc(groupDocId).update({ grammarIds: [...merged] });
    } else {
      await grammarGroups.doc(groupDocId).set({
        id: groupDocId,
        language,
        name: GROUP_NAME,
        grammarIds: [...merged],
        createdAt: new Date().toISOString(),
      });
    }
    console.log(`  OK: "${GROUP_NAME}" now has ${merged.size} member(s) (+${added})`);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
