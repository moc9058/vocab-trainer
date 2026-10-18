import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Requires emulator');
process.env.FIRESTORE_PROJECT = 'demo-import-revisions'; process.env.FIRESTORE_DATABASE_ID = '(default)';
let calls = 0, fail = false, gate: Promise<void> | undefined;
mock.module('../../../src/llm.js', { namedExports: {
  resolveModel: async () => 'mock-model', stripMarkdownFences: (v: string) => v,
  callLLM: async (o: any) => {
    calls++; await gate; if (fail) throw new Error('timeout');
    await o.worker.onUsage({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, 'mock-model');
    if (o.schema.name === 'import_word_assist') return JSON.stringify({ term: '倒是', meaning: '確かに', transliteration: 'dào shì' });
    const { target } = JSON.parse(o.user);
    return JSON.stringify({ paragraphs: [{ sentences: [{ text: target, overview: '文全体の意味', comprehension: { meaning: '承諾はした。', skeleton: '彼が承諾した', connection: '文脈は不十分', nuances: [{ text: '譲歩', evidence: '倒是', certainty: 'inferred' }] }, explanationLanguage: 'ja', ambiguityNotes: [],
      words: [{ term: '倒是', surface: '倒是', occurrence: 0, transliteration: 'dào shì', meaning: '確かに' }], grammar: [{ statement: '倒是', description: '確かに〜だが', elements: [{ wordIndices: [0], role: '固定表現', explanation: '', fixed: true }] }] }] }] });
  }
} });
const { db } = await import('../../../src/firestore.js');
const store = await import('../../../src/import-revision-store.js');
const jobs = await import('../../../src/import-job-store.js');
const { default: routes } = await import('../../../src/routes/import-revisions.js');
const { default: imports } = await import('../../../src/routes/import.js');
await db.doc('config/import').set({ analyzePrompts: { chinese: 'mock' }, analyzeSchema: JSON.parse(readFileSync(new URL('../../../DB/import/analyze_schema.json', import.meta.url), 'utf8')) });
const app = Fastify(); await app.register(sensible); await app.register(routes, { prefix: '/api/import' }); await app.register(imports, { prefix: '/api/import' });
const ids: string[] = [];
async function make() {
  const ref = db.collection('import_sessions').doc(); ids.push(ref.id);
  const s = { language: 'chinese', title: 'revision test', text: '他倒是答应了。第二句。', paragraphs: [{ sentences: [{ index: 0, text: '他倒是答应了。' }, { index: 1, text: '第二句。' }] }], items: [{ id: 'g', kind: 'grammar', statement: '倒是', description: 'old', sentenceIndex: 0, order: 0, origin: 'llm', status: 'registered', existingGrammarId: 'keep-g', registrations: { B: { status: 'registered', groupIds: ['keep-b'] } } }], groupBNames: ['B'], status: 'in-progress', focusedSentenceIndex: 0, createdAt: '', updatedAt: '' };
  await ref.set(s); return { ...s, id: ref.id };
}
const request = (key: string, rev = 0): any => ({ kind: 'regenerate', sentenceIndices: [0], update: 'both', instruction: '簡単に', explanationLanguage: 'ja', expectedRevision: rev, idempotencyKey: key });
async function run(sid: string, rid: string) {
  const d = await db.doc(`import_analysis_jobs/revision-${sid}-${rid}`).get(); const j = d.data()!;
  await jobs.runAnalysisTask({ jobId: j.id, generation: j.generation, batch: j.nextBatch, sequence: j.sequence });
}
test('durable proposal, worker fencing, apply replay, stale save protection, conversion and undo preserve receipts', async () => {
  const s = await make(), base = `/api/import/chinese/sessions/${s.id}`;
  const response = await app.inject({ method: 'POST', url: `${base}/revisions`, payload: request('one') }); assert.equal(response.statusCode, 202, response.body);
  const r = response.json(); const before = calls;
  const replay = await store.startRevision('chinese', s.id, request('one')); assert.equal(replay.id, r.id); assert.equal(calls, before);
  assert.equal((await app.inject({ method: 'PUT', url: base, payload: { items: [] } })).statusCode, 409);
  let release!: () => void; gate = new Promise(resolve => { release = resolve; });
  const task = run(s.id, r.id); while (calls === before) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(run(s.id, r.id), /already running/); release(); await task; gate = undefined;
  const proposed = await store.getRevision('chinese', s.id, r.id); assert.equal(proposed.state, 'proposed'); assert.equal(calls, before + 1); assert.equal(proposed.changes.length, 1);
  assert.equal((await db.doc(`import_sessions/${s.id}`).get()).data()!.items.length, 1);
  const applied = await store.actOnRevision('chinese', s.id, r.id, 'apply', 0, proposed.changes.map(c => c.id), [0]);
  assert.equal(applied.session.contentRevision, 1); assert.equal(applied.session.items.at(-1)!.kind, 'grammar'); assert.deepEqual(applied.session.items.at(-1)!.registrations, s.items[0].registrations);
  assert.equal((await store.actOnRevision('chinese', s.id, r.id, 'apply', 0, [], [])).session.contentRevision, 1);
  assert.equal((await app.inject({ method: 'PUT', url: base, payload: { items: s.items } })).statusCode, 409);
  const undone = await store.actOnRevision('chinese', s.id, r.id, 'undo', 1); assert.equal(undone.session.items.length, 1);
  const input: any = { itemId: 'g', start: 1, end: 3, term: '倒是', meaning: '確かに', transliteration: 'dào shì', explanationLanguage: 'ja', mode: 'replace' };
  const changed = await store.convertWord('chinese', s.id, input, 2, 'conversion');
  const word = changed.session.items.at(-1)!; assert.equal(word.status, 'pending'); assert.equal(word.registrations, undefined); assert.equal(changed.session.items[0].hiddenByRevision, changed.revision.id);
  assert.equal((await store.convertWord('chinese', s.id, input, 2, 'conversion')).session.items.length, 2);
  const saved = await app.inject({ method: 'PUT', url: base, payload: { contentRevision: 3, title: 'another tab edit' } }); assert.equal(saved.statusCode, 200, saved.body);
  await assert.rejects(store.actOnRevision('chinese', s.id, changed.revision.id, 'undo', 4), /article changed/);
  const restored = await store.actOnRevision('chinese', s.id, changed.revision.id, 'restore', 4); assert.equal(restored.revision.state, 'proposed'); assert.equal(restored.session.contentRevision, 4);
  const restoreApplied = await store.actOnRevision('chinese', s.id, restored.revision.id, 'apply', 4, restored.revision.changes.map(c => c.id), [0]);
  assert.equal(restoreApplied.session.paragraphs[0].sentences[0].readingAnalysis, undefined);
  assert.ok(restoreApplied.session.items.some(i => i.id === word.id));
  await app.inject({ method: 'DELETE', url: base }); assert.equal((await db.doc(`import_sessions/${s.id}/revisions/${r.id}`).get()).exists, false);
});
test('saved worker result survives process restart without another model call; bounded failures unlock the article', async () => {
  const s = await make(); const r = await store.startRevision('chinese', s.id, request('recover'));
  await run(s.id, r.id); const before = calls;
  const ref = db.doc(`import_analysis_jobs/revision-${s.id}-${r.id}`), j = (await ref.get()).data()!;
  await ref.update({ state: 'running', nextBatch: 0, nextWakeAt: 0, lease: { token: 'expired', until: 0, attemptId: 'crashed' } });
  await db.doc(`import_sessions/${s.id}`).update({ activeRevisionId: r.id });
  await store.reconcileRevisionJob({ ...j, nextWakeAt: 0 } as any, true); assert.equal(calls, before);
  const broken = await make(); const failed = await store.startRevision('chinese', broken.id, request('fail')); fail = true;
  for (let i = 0; i < 3; i++) await run(broken.id, failed.id);
  assert.equal((await store.getRevision('chinese', broken.id, failed.id)).state, 'failed');
  assert.equal((await db.doc(`import_sessions/${broken.id}`).get()).data()!.activeRevisionId, undefined); fail = false;
});
after(async () => { await app.close(); for (const id of ids) { await db.recursiveDelete(db.doc(`import_sessions/${id}`)); const docs = await db.collection('import_analysis_jobs').where('sessionId', '==', id).get(); for (const d of docs.docs) await db.recursiveDelete(d.ref); } await db.terminate(); });

test('multiple sentences are generated in separate durable parts and keep article-local links', async () => {
  const s = await make();
  await db.doc(`import_sessions/${s.id}`).update({ text: '他倒是答应了。他倒是没行动。', paragraphs: [{ sentences: [{ index: 0, text: '他倒是答应了。' }, { index: 1, text: '他倒是没行动。' }] }] });
  const r = await store.startRevision('chinese', s.id, { ...request('two-parts'), sentenceIndices: [0, 1] });
  const before = calls; await run(s.id, r.id);
  assert.equal((await store.getRevision('chinese', s.id, r.id)).state, 'running');
  await run(s.id, r.id);
  const proposed = await store.getRevision('chinese', s.id, r.id);
  assert.equal(calls, before + 2); assert.equal(proposed.sentences.length, 2);
  assert.ok(proposed.sentences[1].readingAnalysis!.occurrences.every(o => o.id.startsWith('s1-')));
  assert.ok(proposed.sentences[1].readingAnalysis!.constructions.every(c => c.id.startsWith('s1-')));
  const result = await store.actOnRevision('chinese', s.id, r.id, 'apply', 0, proposed.changes.filter(c => c.sentenceIndex === 1).map(c => c.id), [1]);
  assert.equal(result.session.items[0].hiddenByRevision, undefined);
  assert.equal(result.session.paragraphs[0].sentences[0].readingAnalysis, undefined);
  assert.ok(result.session.paragraphs[0].sentences[1].readingAnalysis!.comprehension);
});
