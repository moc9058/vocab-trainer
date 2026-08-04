/**
 * Read-only survey of the saved import sessions for one language.
 *
 * Reports, per session, how many word rows sit on a sentence their term does not
 * occur in — the misattribution the nested-schema change fixes going forward but
 * cannot reach in data already on disk.
 *
 * Usage: npx tsx scripts/inspect-import-sessions.ts [--language=chinese]
 */
import "./_project-env.js";
import { getImportSessions } from "../src/firestore.js";
import { termOccurrences } from "../src/import-analysis.js";
import type { ImportItem, ImportSentence } from "../src/types.js";

const language = process.argv.find((a) => a.startsWith("--language="))?.split("=")[1] ?? "chinese";

function flatten(paragraphs: { sentences: ImportSentence[] }[]): ImportSentence[] {
  return paragraphs.flatMap((p) => p.sentences);
}

async function main() {
  // getImportSessions already returns whole documents, items included.
  const sessions = await getImportSessions(language);
  console.log(`${sessions.length} session(s) for '${language}'\n`);

  for (const session of sessions) {
    const sentences = flatten(session.paragraphs ?? []);
    const textOf = new Map(sentences.map((s) => [s.index, s.text ?? ""]));
    const items: ImportItem[] = session.items ?? [];
    const live = items.filter((i) => i.status !== "skipped");
    const words = live.filter((i) => i.kind === "word");
    const mismatched = words.filter(
      (w) => w.term.trim() && termOccurrences(textOf.get(w.sentenceIndex) ?? "", w.term.trim()).length === 0
    );
    const registered = live.filter((i) => i.status === "registered" || i.status === "duplicate");
    const edited = live.filter((i) => i.origin !== "llm");

    console.log(`--- ${session.id}`);
    console.log(`    title:      ${session.title}`);
    console.log(`    updatedAt:  ${session.updatedAt}`);
    console.log(`    text:       ${(session.text ?? "").length} chars`);
    console.log(`    sentences:  ${sentences.length}`);
    console.log(`    live rows:  ${live.length} (${words.length} words, ${live.length - words.length} grammar)`);
    console.log(`    registered: ${registered.length}`);
    console.log(`    non-llm rows (user edits / gaps / merges / splits): ${edited.length}`);
    console.log(`    MISATTRIBUTED word rows: ${mismatched.length}`);
    for (const w of mismatched.slice(0, 12)) {
      const home = sentences.find((s) => termOccurrences(s.text ?? "", w.term.trim()).length > 0);
      console.log(
        `      「${w.term}」 filed under sentence ${w.sentenceIndex}` +
          (home ? ` — actually in ${home.index}` : " — in NO sentence") +
          (w.status !== "pending" ? ` [${w.status}]` : "")
      );
    }
    if (mismatched.length > 12) console.log(`      … and ${mismatched.length - 12} more`);
    console.log();
  }
}

main().then(() => process.exit(0));
