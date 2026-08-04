/**
 * Finds words whose stored example sentence does not actually contain the word.
 *
 * The importer writes the sentence a row is filed under as the word's example, so a
 * row that was misattributed at registration time put the WRONG sentence into the
 * words collection — permanently, and out of reach of the review screen's repair,
 * which only fixes the session document.
 *
 * Only Chinese and English are checked by default: the fit test is
 * `import-analysis.ts:termOccurrences`, and Japanese and Korean inflect, so an
 * example legitimately spells a word differently from its dictionary form there.
 * `--language` overrides, but expect noise outside the verbatim languages.
 *
 * Read-only. `--fix` is handled by repair-word-example-fit.ts, deliberately a
 * separate script: this one must be safe to run at any time.
 *
 * Usage: npx tsx scripts/audit-word-example-fit.ts [--language=chinese] [--verbose]
 */
import "./_project-env.js";
import { getAllWords } from "../src/firestore.js";
import { termOccurrences } from "../src/import-analysis.js";
import type { Word } from "../src/types.js";

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const verbose = process.argv.includes("--verbose");
const languages = arg("language") ? [arg("language")!] : ["chinese", "english"];

export interface Misfit {
  word: Word;
  /** Index into `word.examples` of the sentence that does not contain the term. */
  exampleIndex: number;
  sentence: string;
}

export function findMisfits(all: Word[]): Misfit[] {
  const out: Misfit[] = [];
  for (const word of all) {
    const term = word.word?.trim();
    if (!term) continue;
    (word.examples ?? []).forEach((ex, exampleIndex) => {
      const sentence = (ex?.sentence ?? "").trim();
      if (!sentence) return;
      if (termOccurrences(sentence, term).length > 0) return;
      out.push({ word, exampleIndex, sentence });
    });
  }
  return out;
}

async function main() {
  for (const language of languages) {
    const all = await getAllWords(language);
    const withExamples = all.filter((w) => (w.examples ?? []).length > 0);
    const misfits = findMisfits(all);
    console.log(
      `\n=== ${language}: ${all.length} words, ${withExamples.length} with examples, ` +
        `${misfits.length} example(s) that do not contain their word`
    );
    for (const m of verbose ? misfits : misfits.slice(0, 25)) {
      console.log(`  「${m.word.word}」 (${m.word.id}) ex#${m.exampleIndex}: ${m.sentence}`);
    }
    if (!verbose && misfits.length > 25) {
      console.log(`  … and ${misfits.length - 25} more (pass --verbose)`);
    }
  }
}

main().then(() => process.exit(0));
