// Fastify route regressions without credentials or Firestore/network access.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { ImportSession } from '../../src/types.js';

const raw = JSON.parse(readFileSync(new URL('../../src/test-fixtures/import-context.json', import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../../DB/import/analyze_schema.json', import.meta.url), 'utf8'));
let stored: ImportSession | null = null;
let response = raw;
let llmCalls = 0;
let fail = false;
let automaticTarget = false;
let capturedSchema: any;
mock.module('../../src/llm.js', { namedExports: {
  stripMarkdownFences: (value: string) => value,
  callLLM: async (options: { onChunk?: (chunk: string) => void; schema?: any; user?: string }) => {
    llmCalls++;
    if (fail) throw new Error('LLM processing exceeded its 180s time limit.');
    capturedSchema = options.schema;
    let output = structuredClone(response);
    if (automaticTarget) {
      const { target } = JSON.parse(options.user!);
      output = { paragraphs: [{ sentences: (target.match(/[^。]+。/g) ?? [target]).map((text: string) => ({ ...structuredClone(raw.paragraphs[0].sentences[0]), text })) }] };
    }
    if (!options.schema?.schema?.properties?.paragraphs?.items?.properties?.sentences?.items?.properties?.overview) {
      for (const paragraph of output.paragraphs) for (const sentence of paragraph.sentences) {
        delete sentence.overview; delete sentence.ambiguityNotes;
        for (const word of sentence.words) for (const key of ['partOfSpeech','role','reasoning','contrast','senseKey']) delete word[key];
        for (const point of sentence.grammar) { delete point.roleInSentence; delete point.elements; }
      }
    }
    const value = JSON.stringify(output);
    options.onChunk?.(value);
    return value;
  },
} });
mock.module('../../src/firestore.js', { namedExports: {
  languageExists: async () => true,
  getImportConfig: async () => ({ analyzeSchema: schema, analyzePrompts: { chinese: 'test prompt' } }),
  getAllGrammarItems: async () => [],
  lookupWordsByTerms: async () => [],
  saveImportSession: async (session: ImportSession) => { stored = structuredClone({ ...session, id: 'article' }); return stored; },
  getImportSession: async () => stored ? structuredClone(stored) : null,
  getImportSessions: async () => stored ? [structuredClone(stored)] : [],
  updateImportSession: async (_id: string, patch: Partial<ImportSession>) => { stored = { ...stored!, ...structuredClone(patch) }; return stored; },
  deleteImportSession: async () => true,
  mutateImportSession: async (_id: string, mutate: (current: ImportSession | null) => ImportSession) => { stored = structuredClone(mutate(stored ? structuredClone(stored) : null)); return stored; },
} });
const { default: routes } = await import('../../src/routes/import.js');
const app = Fastify();
// light-my-request provides a simulated socket without this network-only method.
app.addHook("onRequest", async request => { request.raw.socket.setTimeout = () => request.raw.socket; });
await app.register(sensible);
await app.register(routes, { prefix: '/api/import' });
const base = '/api/import/chinese/sessions';

test('analysis stream, session roundtrip and sentence-only explanation preserve candidates and memberships', async () => {
  const text = raw.paragraphs.flatMap((p: any) => p.sentences).map((s: any) => s.text).join('\n');
  const stream = await app.inject({ method: 'POST', url: '/api/import/chinese/analyze-stream', payload: { text, streamFormat: 'chunks' } });
  assert.equal(stream.statusCode, 200, stream.body);
  assert.ok(stream.body.includes('event: analysis-result'), stream.body);
  const result = JSON.parse(stream.body.split('event: analysis-result\ndata: ')[1].split('\n')[0]);
  assert.equal(result.analysis.paragraphs[0].sentences[0].readingAnalysis, undefined);
  assert.equal(capturedSchema.schema.properties.paragraphs.items.properties.sentences.items.properties.overview, undefined);
  // Save/read compatibility still includes detailed analyses generated explicitly.
  const { normalizeAnalysis } = await import('../../src/import-analysis.js');
  result.analysis.paragraphs = normalizeAnalysis(JSON.stringify(raw), 'chinese').analysis.paragraphs;
  const payload = { text, paragraphs: result.analysis.paragraphs, items: [{ id: 'row', kind: 'word', term: '该', status: 'registered', existingWordId: 'word', registrations: { A: { status: 'registered' } } }],
    wordGroupId: 'a', grammarGroupId: 'g', groupBNames: ['Article'], focusedSentenceIndex: 0, status: 'in-progress' };
  const created = await app.inject({ method: 'POST', url: base, payload });
  assert.equal(created.statusCode, 201, created.body);
  const read = await app.inject(`${base}/article`);
  assert.deepEqual(read.json().paragraphs, payload.paragraphs);
  const before = structuredClone(stored);
  response = { paragraphs: [{ sentences: [raw.paragraphs[0].sentences[0]] }] };
  const explained = await app.inject({ method: 'POST', url: `${base}/article/sentences/0/explanation`, payload: {} });
  assert.equal(explained.statusCode, 200, explained.body);
  assert.equal(explained.json().readingAnalysis.sourceText, payload.paragraphs[0].sentences[0].text);
  assert.deepEqual(stored, before, 'explanation endpoint must not write a session or registration');
  const patched = structuredClone(payload.paragraphs);
  patched[0].sentences[0].readingAnalysis.overview = 'updated explanation';
  const saved = await app.inject({ method: 'PUT', url: `${base}/article`, payload: { paragraphs: patched } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().items, payload.items);
  assert.deepEqual(saved.json().groupBNames, payload.groupBNames);
  assert.equal((await app.inject(`${base}/article`)).json().paragraphs[0].sentences[0].readingAnalysis.overview, 'updated explanation');
  response = { paragraphs: [{ sentences: [raw.paragraphs[1].sentences[0]] }] };
  const nextSentence = await app.inject({ method: 'POST', url: `${base}/article/sentences/1/explanation`, payload: {} });
  assert.equal(nextSentence.statusCode, 200, nextSentence.body);
  assert.ok(nextSentence.json().readingAnalysis.occurrences.every((word: any) => word.id.startsWith('s1-')));
  assert.equal(llmCalls, 3);
});

test('sentence generation rejects wrong language, missing/invalid sentence, changed text and failed LLM', async () => {
  for (const [url, code] of [
    ['/api/import/english/sessions/article/sentences/0/explanation', 404],
    [`${base}/article/sentences/99/explanation`, 404],
    [`${base}/article/sentences/nope/explanation`, 400],
  ] as const) {
    const result = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(result.statusCode, code, result.body);
  }
  const before = structuredClone(stored);
  response = { paragraphs: [{ sentences: [{ ...raw.paragraphs[0].sentences[0], text: 'rewritten' }] }] };
  const mismatch = await app.inject({ method: 'POST', url: `${base}/article/sentences/0/explanation`, payload: {} });
  assert.equal(mismatch.statusCode, 502);
  fail = true;
  const unavailable = await app.inject({ method: 'POST', url: `${base}/article/sentences/0/explanation`, payload: {} });
  assert.equal(unavailable.statusCode, 502);
  assert.deepEqual(stored, before);
  fail = false;
});

test('oversized session data is rejected before a Firestore write', async () => {
  const before = structuredClone(stored);
  const result = await app.inject({ method: 'PUT', url: `${base}/article`, payload: { title: 'x'.repeat(905_000) } });
  assert.equal(result.statusCode, 400, result.body);
  assert.deepEqual(stored, before);

});

test('cached clients receive a reload instruction before attempting a long legacy stream', async () => {
  const before = llmCalls;
  const result = await app.inject({ method: 'POST', url: '/api/import/chinese/analyze-stream', payload: { text: '文'.repeat(601) } });
  assert.equal(result.statusCode, 400);
  assert.match(result.body, /Reload/);
  assert.equal(llmCalls, before);
});

test('bounded analysis checkpoints survive timeout, stale edits, concurrent calls and lost responses', async () => {
  automaticTarget = true; fail = false;
  const text = raw.paragraphs[0].sentences[0].text.repeat(35);
  const created = await app.inject({ method: 'POST', url: base, payload: { text, paragraphs: [], items: [], analyzeInParts: true, wordGroupId: 'a', groupBNames: ['Read'] } });
  assert.equal(created.statusCode, 201, created.body);
  assert.ok(created.json().analysisProgress.chunks.length > 1);
  const endpoint = `${base}/article/analyze-next`;
  const first = await app.inject({ method: 'POST', url: endpoint, payload: { chunkIndex: 0 } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().analysisProgress.nextChunk, 1);
  const before = structuredClone(stored!);
  const replayCalls = llmCalls;
  const replay = await app.inject({ method: 'POST', url: endpoint, payload: { chunkIndex: 0 } });
  assert.deepEqual(replay.json(), JSON.parse(JSON.stringify(before)));
  assert.equal(llmCalls, replayCalls);
  fail = true;
  const failed = await app.inject({ method: 'POST', url: endpoint, payload: { chunkIndex: 1 } });
  assert.equal(failed.statusCode, 504, failed.body);
  assert.equal(failed.json().code, 'IMPORT_TIMEOUT');
  assert.deepEqual(stored, before);
  const stale = await app.inject({ method: 'PUT', url: `${base}/article`, payload: { analysisCheckpoint: 0, items: [] } });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stored, before);
  const edited = structuredClone(before.items);
  edited[0].status = 'registered'; edited[0].registrations = { A: { status: 'registered', groupIds: ['a'] } };
  const saved = await app.inject({ method: 'PUT', url: `${base}/article`, payload: { analysisCheckpoint: 1, items: edited } });
  assert.equal(saved.statusCode, 200, saved.body);
  fail = false;
  const resumed = await Promise.all([0, 1].map(() => app.inject({ method: 'POST', url: endpoint, payload: { chunkIndex: 1 } })));
  assert.ok(resumed.every(result => result.statusCode === 200));
  assert.equal(stored!.analysisProgress!.nextChunk, 2);
  assert.deepEqual(stored!.items.slice(0, edited.length), edited);
  assert.equal(new Set(stored!.items.map(item => item.id)).size, stored!.items.length);
  assert.deepEqual(stored!.groupBNames, ['Read']);
  assert.equal(stored!.wordGroupId, 'a');
  const indices = stored!.paragraphs.flatMap(p => p.sentences).map(sentence => sentence.index);
  assert.equal(new Set(indices).size, indices.length);

});

test('a timed-out part is subdivided before retry while completed state and original source remain intact', async () => {
  const text = raw.paragraphs[0].sentences[0].text.repeat(80);
  const created = await app.inject({ method: 'POST', url: base, payload: { text, paragraphs: [], items: [], analyzeInParts: true, groupBNames: ['Read'] } });
  assert.equal(created.statusCode, 201);
  const previousCount = stored!.analysisProgress!.chunks.length;
  fail = true;
  const failed = await app.inject({ method: 'POST', url: `${base}/article/analyze-next`, payload: { chunkIndex: 0 } });
  assert.equal(failed.statusCode, 504, failed.body);
  assert.equal(stored!.analysisProgress!.nextChunk, 0);
  assert.equal(stored!.analysisProgress!.chunks.length, previousCount + 1);
  assert.equal(stored!.analysisProgress!.chunks.join(''), text);
  assert.deepEqual(stored!.items, []);
  assert.deepEqual(stored!.groupBNames, ['Read']);
  fail = false;
  const resumed = await app.inject({ method: 'POST', url: `${base}/article/analyze-next`, payload: { chunkIndex: 0 } });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(stored!.analysisProgress!.nextChunk, 1);
});
after(() => app.close());
