/**
 * Re-runs the analysis for a saved import session and replaces its paragraphs and
 * items with the result.
 *
 * Sessions analyzed before words were nested inside their sentence carry whatever
 * the model miscounted — the review screen's bulk fix repairs the ATTRIBUTION of
 * those rows deterministically, but it cannot improve the extraction itself. This
 * re-runs the whole thing through the current prompt and schema, which is the only
 * way to get a session that was analyzed under the old contract up to the standard
 * a fresh import now meets.
 *
 * It reproduces exactly what `routes/import.ts:analyze-stream` + `ImportView` do on
 * a new import — including importing the FRONTEND's own `buildImportItems`, rather
 * than re-implementing its ordering and gap materialization here, so a session
 * rebuilt by this script is indistinguishable from one the app produced.
 *
 * Destinations, title, text and id are preserved; per-item edits and the session's
 * record of which rows it registered are NOT (registrations already written to the
 * library are unaffected, and the review screen reads its ✓ from real group
 * membership rather than from item status). The previous document is written to
 * backend/data/reanalyze-backup/ before anything is overwritten.
 *
 * Usage:
 *   npx tsx scripts/reanalyze-import-session.ts --session=<id> [--dry-run]
 *   npx tsx scripts/reanalyze-import-session.ts --language=chinese --all [--dry-run]
 */
import "./_project-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callLLM, stripMarkdownFences } from "../src/llm.js";
import {
  getAllGrammarItems,
  getImportConfig,
  getImportSessions,
  lookupWordsByTerms,
  updateImportSession,
} from "../src/firestore.js";
import {
  lowercaseGrammarAbbreviations,
  normalizeAnalysis,
  termOccurrences,
} from "../src/import-analysis.js";
import type { ImportSession } from "../src/types.js";

/**
 * The frontend owns the analysis → rows transformation (character-offset ordering,
 * gap materialization), so this borrows it rather than re-implementing it — a copy
 * would drift from the app the moment either side changed.
 *
 * Loaded dynamically because the two projects disagree about module format: the
 * frontend has no `"type": "module"`, so tsx loads it as CJS and its named exports
 * arrive under `default`. A static `import { … }` fails outright.
 */
type BuildImportItems = (
  analysis: Awaited<ReturnType<typeof normalizeAnalysis>>["analysis"],
  existing: Record<string, string>,
  existingGrammar: Record<string, string>,
  language: string
) => ImportSession["items"];

async function loadBuildImportItems(): Promise<BuildImportItems> {
  const mod: any = await import("../../frontend/src/utils/importSession.ts");
  const fn = (mod.default ?? mod).buildImportItems;
  if (typeof fn !== "function") {
    throw new Error("buildImportItems not found in frontend/src/utils/importSession.ts");
  }
  return fn as BuildImportItems;
}

const STYLE_EXAMPLE_LIMIT = 40;

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const sessionId = arg("session");
const language = arg("language") ?? "chinese";
const all = process.argv.includes("--all");
const dryRun = process.argv.includes("--dry-run");

const BACKUP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "reanalyze-backup");

function buildAnalyzeSystemPrompt(basePrompt: string, statements: string[]): string {
  if (statements.length === 0) return basePrompt;
  return (
    `${basePrompt}\n\n## Existing grammar statements (style reference)\n\n` +
    `Write the \`statement\` field in the same notation as these entries already in the user's database:\n\n` +
    statements.map((s) => `- ${lowercaseGrammarAbbreviations(s)}`).join("\n")
  );
}

function misattributed(session: ImportSession) {
  const textOf = new Map(
    (session.paragraphs ?? []).flatMap((p) => p.sentences).map((s) => [s.index, s.text ?? ""])
  );
  return (session.items ?? []).filter(
    (i) =>
      i.status !== "skipped" &&
      i.kind === "word" &&
      i.term.trim() &&
      termOccurrences(textOf.get(i.sentenceIndex) ?? "", i.term.trim()).length === 0
  );
}

async function reanalyze(session: ImportSession) {
  const text = (session.text ?? "").trim();
  console.log(`\n=== ${session.id} — ${session.title}`);
  console.log(`    ${text.length} chars, ${(session.items ?? []).length} stored rows`);
  console.log(`    misattributed before: ${misattributed(session).length}`);
  if (!text) {
    console.log("    SKIPPED: the session stores no source text to re-analyze.");
    return;
  }

  const config = await getImportConfig();
  const basePrompt = config.analyzePrompts?.[session.language];
  if (!basePrompt) throw new Error(`No import prompt configured for '${session.language}'`);

  const grammarItems = await getAllGrammarItems(session.language);
  const statements = grammarItems
    .map((g) => g.statement)
    .filter(Boolean)
    .slice(0, STYLE_EXAMPLE_LIMIT);

  console.log("    calling the model…");
  const raw = await callLLM({
    system: buildAnalyzeSystemPrompt(basePrompt, statements),
    user: text,
    schema: config.analyzeSchema,
    tier: "full",
    route: "import/analyze-stream",
  });
  const { analysis, repair } = normalizeAnalysis(stripMarkdownFences(raw), session.language);

  const terms = [...new Set(analysis.words.map((w) => w.term.trim()).filter(Boolean))];
  const existing: Record<string, string> = {};
  if (terms.length > 0) {
    for (const m of await lookupWordsByTerms(session.language, terms)) existing[m.term] = m.id;
  }
  const existingGrammar: Record<string, string> = {};
  for (const g of grammarItems) {
    const key = lowercaseGrammarAbbreviations(g.statement ?? "").trim();
    if (key && !existingGrammar[key]) existingGrammar[key] = g.id;
  }

  const buildImportItems = await loadBuildImportItems();
  const items = buildImportItems(analysis, existing, existingGrammar, session.language);
  const rebuilt = { ...session, paragraphs: analysis.paragraphs, items };

  const sentenceCount = analysis.paragraphs.flatMap((p) => p.sentences).length;
  console.log(
    `    → ${sentenceCount} sentences, ${analysis.words.length} words, ` +
      `${analysis.grammar.length} grammar → ${items.length} rows`
  );
  console.log(
    `    server repair: ${repair.reassigned} moved, ${repair.dropped} dropped, ` +
      `${repair.redundant} redundant, ${repair.unmatched} unmatched`
  );
  for (const s of repair.samples) console.log(`      · ${s}`);
  const left = misattributed(rebuilt);
  console.log(`    misattributed after: ${left.length}`);
  for (const w of left) {
    console.log(`      · 「${(w as any).term}」 on sentence ${w.sentenceIndex} [origin ${w.origin}]`);
  }
  console.log(`    already in the library: ${Object.keys(existing).length} of ${terms.length} terms`);

  if (dryRun) {
    console.log("    DRY RUN — nothing written.");
    return;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup = join(BACKUP_DIR, `${session.id}.json`);
  writeFileSync(backup, JSON.stringify(session, null, 2), "utf-8");
  console.log(`    backed up the previous document to ${backup}`);

  await updateImportSession(session.id, {
    paragraphs: analysis.paragraphs,
    items,
    focusedSentenceIndex: analysis.paragraphs[0]?.sentences[0]?.index ?? 0,
  });
  console.log("    written.");
}

async function main() {
  const sessions = await getImportSessions(language);
  const targets = sessionId
    ? sessions.filter((s) => s.id === sessionId)
    : all
    ? sessions
    : sessions.filter((s) => misattributed(s).length > 0);

  if (targets.length === 0) {
    console.log(
      sessionId
        ? `No session '${sessionId}' for language '${language}'.`
        : `No '${language}' session needs re-analysis (pass --all to force).`
    );
    return;
  }
  console.log(`Re-analyzing ${targets.length} of ${sessions.length} '${language}' session(s)`);
  for (const session of targets) await reanalyze(session);
}

main().then(() => process.exit(0));
