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
