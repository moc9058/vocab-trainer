import { getGrammarGroups, deleteGrammarGroup } from "../src/firestore.js";

const LANGUAGE = "zh";
const KEEP_NAME = "Group 1";

async function main() {
  const groups = await getGrammarGroups(LANGUAGE);
  console.log(`Found ${groups.length} grammar group(s) for "${LANGUAGE}":`);
  for (const g of groups) {
    console.log(`  ${g.id}\t"${g.name}"\t${g.grammarIds.length} item(s)`);
  }

  const toDelete = groups.filter((g) => g.name !== KEEP_NAME);
  const toKeep = groups.filter((g) => g.name === KEEP_NAME);

  if (toKeep.length === 0) {
    console.log(`\nWARNING: no group named "${KEEP_NAME}" found for "${LANGUAGE}". Aborting — nothing deleted.`);
    return;
  }

  if (toDelete.length === 0) {
    console.log(`\nNothing to delete — only "${KEEP_NAME}" exists.`);
    return;
  }

  console.log(`\nDeleting ${toDelete.length} group(s):`);
  for (const g of toDelete) {
    console.log(`  ${g.id}\t"${g.name}"`);
    await deleteGrammarGroup(g.id);
  }

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
