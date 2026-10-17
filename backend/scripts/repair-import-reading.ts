/** Add sentence-level syntax to a saved article without replacing candidates or registrations.
 * npx tsx scripts/repair-import-reading.ts --session=<id> [--sentence=1 | --missing] [--apply] [--concurrency=1..3]
 * Generates a backup and cached explanation per target before any transactional write.
 */
import "./_project-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getImportSession, getImportConfig, mutateImportSession } from "../src/firestore.js";
import { callLLM, stripMarkdownFences } from "../src/llm.js";
import { normalizeAnalysis } from "../src/import-analysis.js";
import { COMPACT_IMPORT_INSTRUCTIONS, compactImportSchema } from "../src/import-analysis-config.js";
import { jobActive } from "../src/import-jobs.js";
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = arg("session");
if (!id) throw new Error("--session is required");
const apply = process.argv.includes("--apply");
const session = await getImportSession(id);
if (!session || jobActive(session.analysisState)) throw new Error("Session missing or analysis active");
const dir = fileURLToPath(new URL(`../data/reading-repair/${id}-${Date.now()}/`, import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/before.json`, JSON.stringify(session, null, 2));
const mod: any = await import("../../frontend/src/utils/importReadingAnalysis.ts");
const { reconcileReadingSession } = mod.default ?? mod;
const config = await getImportConfig();
const repairSchema = compactImportSchema(config.analyzeSchema) as any;
const sentenceSchema = repairSchema.schema.properties.paragraphs.items.properties.sentences.items;
sentenceSchema.properties.overview = { type: "string" };
sentenceSchema.required = [...new Set([...sentenceSchema.required, "overview"])];
const sentences = session.paragraphs.flatMap(p => p.sentences);
const targets = sentences.filter(s => arg("sentence") !== undefined ? s.index === Number(arg("sentence"))
  : !process.argv.includes("--missing") || !s.readingAnalysis);
if (!targets.length) { console.log("No matching sentences need repair"); process.exit(0); }
async function repairSentence(sentence: (typeof sentences)[number]) {
  const at = sentences.findIndex(s => s.index === sentence.index);
  const storedPatterns = session.items.filter(i => i.kind === "grammar" && i.sentenceIndex === sentence.index && i.status !== "skipped").map(i => i.kind === "grammar" ? i.statement : "");
  console.log(`Generating sentence ${sentence.index} (${sentence.text.length} chars)`);
  const raw = await callLLM({
    system: config.analyzePrompts[session.language] + COMPACT_IMPORT_INSTRUCTIONS
      + "\nAnalyze ONLY target as exactly one sentence. before/after are context. Preserve target verbatim. Return overview as an empty string. Include each supported existingPattern with complete element links; use its exact statement notation. Do not invent unsupported patterns.",
    user: JSON.stringify({ target: sentence.text, before: sentences[at - 1]?.text ?? "", after: sentences[at + 1]?.text ?? "", existingPatterns: storedPatterns }),
    schema: repairSchema, tier: "full", route: "import/sentence-explanation",
  });
  const { analysis } = normalizeAnalysis(stripMarkdownFences(raw), session.language);
  const result = analysis.paragraphs.flatMap(p => p.sentences);
  if (result.length !== 1 || result[0].text !== sentence.text || !result[0].readingAnalysis) throw new Error("Explanation does not match the original sentence");
  const reading = result[0].readingAnalysis;
  const reindex = (value: string) => value.replace(/^s0-/, `s${sentence.index}-`);
  reading.occurrences = reading.occurrences.map(word => ({ ...word, id: reindex(word.id), constructionIds: word.constructionIds.map(reindex) }));
  reading.constructions = reading.constructions.map(point => ({ ...point, id: reindex(point.id), elements: point.elements.map(element => ({ ...element, occurrenceIds: element.occurrenceIds.map(reindex) })) }));
  // Every construction must provide both an anchored fixed element and its declared slots.
  for (const point of reading.constructions) {
    if (!point.elements.length) throw new Error(`Missing elements: ${point.statement}`);
    const namedSlots = new Set(point.statement.match(/\b[AB]\b/g) ?? []);
    if (namedSlots.size && point.elements.filter(element => !element.fixed).length < namedSlots.size) throw new Error(`Missing variable slots: ${point.statement}`);
  }
  writeFileSync(`${dir}/sentence-${sentence.index}.json`, JSON.stringify(reading, null, 2));
  if (apply) await mutateImportSession(id, current => {
    const live = current?.paragraphs.flatMap(p => p.sentences).find(s => s.index === sentence.index);
    if (!current || jobActive(current.analysisState) || live?.text !== sentence.text || JSON.stringify(live.readingAnalysis) !== JSON.stringify(sentence.readingAnalysis)) throw new Error("Concurrent change; refusing to overwrite");
    const next = reconcileReadingSession({ ...current, paragraphs: current.paragraphs.map(p => ({ ...p, sentences: p.sentences.map(s => s.index === sentence.index ? { ...s, readingAnalysis: reading } : s) })), updatedAt: new Date().toISOString() });
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > 900_000) throw new Error("Session storage limit");
    return next;
  });
  console.log(`${apply ? "Saved" : "Dry run"} sentence ${sentence.index}: ${reading.constructions.length} constructions, ${reading.occurrences.length} occurrences`);
}
const concurrency = Number(arg("concurrency") ?? 1);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("concurrency must be 1, 2 or 3");
let cursor = 0;
const errors: unknown[] = [];
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < targets.length) {
    const sentence = targets[cursor++];
    try { await repairSentence(sentence); } catch (error) { errors.push(error); console.error(`Sentence ${sentence.index} failed:`, error); }
  }
}));
console.log(`Backups and generated results: ${dir}`);
if (errors.length) process.exitCode = 1;
