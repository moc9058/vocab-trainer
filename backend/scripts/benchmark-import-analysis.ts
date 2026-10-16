// Explicit limited real-LLM benchmark; no source text in the output and no production DB writes.
import './_project-env.js';
import { readFile, writeFile } from 'node:fs/promises';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Benchmark requires FIRESTORE_EMULATOR_HOST');
const input = process.argv[2], output = process.argv[3];
if (!input || !output) throw new Error('Usage: benchmark-import-analysis.ts INPUT.txt OUTPUT.json [target=300] [maxCalls=5]');
const source = await readFile(input, 'utf8');
if (!source.trim() || source.length > 8000) throw new Error('Source must contain 1–8000 characters');
const { createImportSnapshot } = await import('../src/import-job-store.js');
const { planImportBatches, importSentenceTexts } = await import('../src/import-jobs.js');
const { callLLM, stripMarkdownFences } = await import('../src/llm.js');
const { normalizeAnalysis } = await import('../src/import-analysis.js');
const { sourceMatchesSentences } = await import('../src/import-reading-analysis.js');
const frozen = await createImportSnapshot('chinese');
const target = Number(process.argv[4] ?? 300), maxCalls = Number(process.argv[5] ?? 5);
const all = { full: [source], grouped: planImportBatches(source, 'chinese', target) };
const strategies = process.argv[6] === 'grouped' ? { grouped: all.grouped } : all;
if (!Number.isFinite(target) || target < 1 || Object.values(strategies).reduce((n, parts) => n + parts.length, 0) > maxCalls) throw new Error('Benchmark call limit exceeded');
const report: any = { createdAt: new Date().toISOString(), model: frozen.model, sourceLength: source.length, groupedTarget: target, runs: [] };
for (const [strategy, parts] of Object.entries(strategies)) {
  for (const [part, text] of parts.entries()) {
    const started = Date.now(); let usage: unknown;
    try {
      const raw = await callLLM({ system: frozen.system, schema: frozen.schema, user: JSON.stringify({ target: text, sentenceTexts: importSentenceTexts(text, 'chinese'), before: parts[part - 1]?.slice(-300) ?? '', after: parts[part + 1]?.slice(0, 300) ?? '' }), route: 'import/analyze-part', tier: 'full', worker: { model: frozen.model, onUsage: async value => { usage = value; } } });
      const analysis = normalizeAnalysis(stripMarkdownFences(raw), 'chinese').analysis;
      report.runs.push({ strategy, part, sourceLength: text.length, elapsedMs: Date.now() - started, usage: usage ?? null, bytes: Buffer.byteLength(raw), sourceMatches: sourceMatchesSentences(text, analysis.paragraphs.flatMap(p => p.sentences).map(s => s.text)), words: analysis.words.length, grammar: analysis.grammar.length });
    } catch (err) { report.runs.push({ strategy, part, sourceLength: text.length, elapsedMs: Date.now() - started, usage: usage ?? null, error: err instanceof Error ? err.message : 'failed' }); }
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.runs.at(-1)));
  }
}
