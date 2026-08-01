
// Must stay the FIRST import: it publishes FIRESTORE_PROJECT to the environment
// before the Firestore client below reads it — without it the client resolves to
// gcloud's default project, which has no `vocab-database`, and every query dies
// with a bare `5 NOT_FOUND`.
import "./_project-env.js";
import { getGrammarGroups } from "../src/firestore";

const LANGS = ["en", "ja", "ko", "zh"];

async function main() {
  for (const lang of LANGS) {
    const groups = await getGrammarGroups(lang);
    console.log(`\n=== ${lang} (${groups.length}) ===`);
    for (const g of groups) {
      console.log(`${g.id}\t"${g.name}"\t${g.grammarIds.length} items`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
