// Fastify route regressions without credentials or Firestore/network access.
import { test, mock } from 'node:test';
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
mock.module('../../src/llm.js', { namedExports: {
  stripMarkdownFences: (value: string) => value,
  callLLM: async (options: { onChunk?: (chunk: string) => void }) => {
    llmCalls++;
    if (fail) throw new Error('mock unavailable');
    const value = JSON.stringify(response);
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
  assert.equal(result.analysis.paragraphs[0].sentences[0].readingAnalysis.version, 1);
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
  await app.close();
});
