// Explicit emulator-only integration suite. No production access and no real LLM calls.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Requires FIRESTORE_EMULATOR_HOST');
process.env.FIRESTORE_PROJECT = 'demo-import-jobs';
process.env.FIRESTORE_DATABASE_ID = '(default)';
let calls = 0, failure = false, outputLimit = false;
let block: Promise<void> | undefined;
mock.module('../../../src/llm.js', { namedExports: {
  resolveModel: async () => 'mock-model', stripMarkdownFences: (v: string) => v,
  callLLM: async (o: any) => {
    calls++; await block;
    if (outputLimit) throw new Error('IMPORT_OUTPUT_LIMIT');
    if (failure) throw new Error('LLM processing exceeded its 540s time limit.');
    await o.worker.onUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 30 } }, 'mock-model');
    const target = JSON.parse(o.user).target;
    return JSON.stringify({ paragraphs: [{ sentences: [...new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(target)].map(s => ({ text: s.segment.trim(), explanationLanguage: 'ja', words: [], grammar: [] })) }] });
  },
} });
const { db } = await import('../../../src/firestore.js');
const jobs = await import('../../../src/import-job-store.js');
const { planImportBatches } = await import('../../../src/import-jobs.js');
const { default: jobRoutes } = await import('../../../src/routes/import-jobs.js');
const { default: importRoutes } = await import('../../../src/routes/import.js');
const { importWorkerRoutes } = await import('../../../src/routes/import-worker.js');
await db.doc('config/import').set({ analyzePrompts: { chinese: 'Test only' }, analyzeSchema: {} });
const app = Fastify(); await app.register(sensible); await app.register(importRoutes, { prefix: '/api/import' }); await app.register(jobRoutes, { prefix: '/api/import' }); await app.register(importWorkerRoutes, { prefix: '/internal/import-analysis' });
const created: string[] = [];
async function make(text = '你好。第二句。', target = 600) {
  const ref = db.collection('import_sessions').doc(); created.push(ref.id);
  await ref.set({ language: 'chinese', title: 'Emulator job test', text, paragraphs: [], items: [], groupBNames: ['Keep B'], wordGroupId: 'keep-a', focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '', analysisProgress: { version: 1, chunks: planImportBatches(text, 'chinese', target), nextChunk: 0 } });
  return jobs.startAnalysisJob('chinese', ref.id, 'initial', 0);
}
const payload = (j: any) => ({ jobId: j.id, generation: j.generation, batch: j.nextBatch, sequence: j.sequence });
async function until(check: () => boolean) { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); }

test('acceptance is quick, concurrent starts share a job, duplicate workers call LLM once, replay adds nothing', async () => {
  const before = calls; const j = await make();
  const same = await Promise.all([jobs.startAnalysisJob('chinese', j.id, 'another', 0), jobs.startAnalysisJob('chinese', j.id, 'initial', 0)]);
  assert.ok(same.every(x => x.id === j.id)); assert.equal(calls, before);
  let release!: () => void; block = new Promise(r => { release = r; });
  const run = jobs.runAnalysisTask(payload(j)); await until(() => calls === before + 1);
  await assert.rejects(jobs.runAnalysisTask(payload(j)), /already running/);
  const active = await jobs.getAnalysisJob(j.id);
  assert.equal(active!.state, 'running');
  const response = await app.inject({ method: 'POST', url: `/api/import/chinese/sessions/${j.id}/analysis-job/resume`, payload: { idempotencyKey: 'resume-inflight' } });
  assert.equal(response.statusCode, 202); assert.equal(response.json().state, 'running'); assert.equal(calls, before + 1);
  release(); await run; block = undefined;
  const s = (await db.doc(`import_sessions/${j.id}`).get()).data()!;
  assert.equal(s.analysisState, 'completed'); assert.deepEqual(s.groupBNames, ['Keep B']); assert.equal(s.wordGroupId, 'keep-a');
  const count = s.items.length; await jobs.runAnalysisTask(payload(j)); assert.equal(calls, before + 1);
  assert.equal((await db.doc(`import_sessions/${j.id}`).get()).data()!.items.length, count);
  const attempts = await db.collection(`import_analysis_jobs/${j.id}/attempts`).get();
  assert.equal(attempts.size, 1); assert.equal(attempts.docs[0].data().usageUnknown, false);
});

test('pause waits for current work, edits survive resumed append, stale saves and legacy calls are rejected', async () => {
  const j = await make('第一句。第二句。第三句。', 6);
  let release!: () => void; block = new Promise(r => { release = r; });
  const before = calls, running = jobs.runAnalysisTask(payload(j)); await until(() => calls === before + 1);
  await jobs.changeAnalysisJob('chinese', j.id, 'pause', 'pause-key'); release(); await running; block = undefined;
  let current = (await jobs.getAnalysisJob(j.id))!; assert.equal(current.state, 'paused'); assert.equal(current.nextBatch, 1);
  const ref = db.doc(`import_sessions/${j.id}`); const s = (await ref.get()).data()!;
  const stale = await app.inject({ method: 'PUT', url: `/api/import/chinese/sessions/${j.id}`, payload: { items: [], analysisCheckpoint: 0 } }); assert.equal(stale.statusCode, 409);
  s.items[0].meaning = 'User edited'; s.items[0].status = 'registered'; s.items[0].registrations = { B: { status: 'registered', groupIds: ['keep-b'] } };
  const edited = await app.inject({ method: 'PUT', url: `/api/import/chinese/sessions/${j.id}`, payload: { items: s.items, contentRevision: s.contentRevision, analysisCheckpoint: 1, analysisRevision: s.analysisRevision } }); assert.equal(edited.statusCode, 200, edited.body);
  const legacy = await app.inject({ method: 'POST', url: `/api/import/chinese/sessions/${j.id}/analyze-next`, payload: { chunkIndex: 1 } }); assert.equal(legacy.statusCode, 409);
  current = await jobs.changeAnalysisJob('chinese', j.id, 'resume', 'resume-key');
  await jobs.runAnalysisTask(payload(current)); current = (await jobs.getAnalysisJob(j.id))!;
  await jobs.runAnalysisTask(payload(current));
  const final = (await ref.get()).data()!; assert.equal(final.analysisState, 'completed'); assert.equal(final.items[0].meaning, 'User edited'); assert.deepEqual(final.items[0].registrations, s.items[0].registrations);
});

test('saved result recovers after a crash with no extra LLM; lease fencing and deletion prevent late writes', async () => {
  const j = await make(); const claim = (await jobs.claimAnalysisJob(payload(j)))!;
  const result = { analysis: { paragraphs: [{ sentences: [{ index: 0, text: '你好。第二句。' }] }], words: [], grammar: [] }, existing: {}, existingGrammar: {} };
  await db.doc(`import_analysis_jobs/${j.id}/results/0`).set(result);
  await db.doc(`import_analysis_jobs/${j.id}`).update({ lease: { ...claim.lease, until: 0 }, nextWakeAt: 0 });
  const before = calls; await jobs.reconcileAnalysisJobs(true); assert.equal(calls, before); assert.equal((await jobs.getAnalysisJob(j.id))!.state, 'completed');
  const late = await make(); const leased = (await jobs.claimAnalysisJob(payload(late)))!;
  const deleted = await app.inject({ method: 'DELETE', url: `/api/import/chinese/sessions/${late.id}` }); assert.equal(deleted.statusCode, 200);
  assert.equal(await jobs.commitAnalysisResult(leased, result), null); assert.equal((await db.doc(`import_sessions/${late.id}`).get()).exists, false);
});

test('retry budget is finite and repeated resume operation cannot restart a failed job twice', async () => {
  failure = true; let j = await make(); const before = calls;
  for (let i = 0; i < 3; i++) { await jobs.runAnalysisTask(payload(j)); j = (await jobs.getAnalysisJob(j.id))!; }
  assert.equal(calls, before + 3); assert.equal(j.state, 'failed');
  const first = await jobs.changeAnalysisJob('chinese', j.id, 'resume', 'one-user-click');
  for (let i = 0, x = first; i < 3; i++) { await jobs.runAnalysisTask(payload(x)); x = (await jobs.getAnalysisJob(j.id))!; }
  const replay = await jobs.changeAnalysisJob('chinese', j.id, 'resume', 'one-user-click'); assert.equal(replay.state, 'failed');
  failure = false;
});

test('internal worker rejects forged queue headers and cookies; state responses omit source and prompt', async () => {
  const j = await make();
  const rejected = await app.inject({ method: 'POST', url: '/internal/import-analysis/run', headers: { 'x-cloudtasks-taskname': 'forged', cookie: 'vt_session=forged' }, payload: payload(j) }); assert.equal(rejected.statusCode, 401);
  const state = await app.inject(`/api/import/chinese/sessions/${j.id}/analysis-job`); assert.equal(state.statusCode, 200); assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.json().snapshot, undefined); assert.equal(state.json().chunks, undefined);
});
after(async () => { await app.close(); for (const id of created) { await db.doc(`import_sessions/${id}`).delete(); await db.recursiveDelete(db.doc(`import_analysis_jobs/${id}`)); } await db.terminate(); });

test('an expired crashed attempt honors pause without another paid call; deleted job cleanup is bounded', async () => {
  const j = await make(); const claimed = (await jobs.claimAnalysisJob(payload(j)))!;
  await jobs.changeAnalysisJob('chinese', j.id, 'pause', 'stop-after-crash');
  await db.doc(`import_analysis_jobs/${j.id}`).update({ lease: { ...claimed.lease!, until: 0 }, nextWakeAt: 0 });
  const before = calls; await jobs.reconcileAnalysisJobs(true);
  assert.equal((await db.collection(`import_analysis_jobs/${j.id}/attempts`).get()).size, 1); assert.equal((await jobs.getAnalysisJob(j.id))!.state, 'paused');
  assert.equal((await db.doc(`import_sessions/${j.id}`).get()).data()!.analysisState, 'paused');
  await app.inject({ method: 'DELETE', url: `/api/import/chinese/sessions/${j.id}` });
  await db.doc(`import_analysis_jobs/${j.id}`).update({ cleanupAt: 0 });
  await jobs.reconcileAnalysisJobs(true);
  assert.equal((await db.doc(`import_analysis_jobs/${j.id}`).get()).exists, false);
});


test('output limits only retry on explicit resume and split multiple complete sentences without touching saved work', async () => {
  outputLimit = true; const j = await make('第一句。第二句。第三句。');
  await jobs.runAnalysisTask(payload(j)); const failed = (await jobs.getAnalysisJob(j.id))!;
  assert.equal(failed.state, 'failed'); assert.equal(failed.error?.retryable, true);
  const next = await jobs.changeAnalysisJob('chinese', j.id, 'resume', 'smaller-complete-sentences');
  assert.ok(next.totalBatches > 1); assert.equal(next.chunks.join(''), j.chunks.join(''));
  assert.ok(next.chunks.every(s => s.endsWith('。'))); assert.equal(next.nextBatch, 0);
  assert.equal(next.generation, failed.generation + 1); outputLimit = false;
});

test('an 8000-character source completes across sentence batches with exact source coverage and bounded storage', async () => {
  const text = '这是一段用于验证保存和显示的外部文本。'.repeat(500).slice(0, 8000);
  assert.equal(text.length, 8000);
  let j = await make(text);
  assert.ok(j.totalBatches > 1);
  const started = performance.now();
  while (j.state === 'queued') {
    await jobs.runAnalysisTask(payload(j)); j = (await jobs.getAnalysisJob(j.id))!;
  }
  assert.equal(j.state, 'completed');
  const s = (await db.doc(`import_sessions/${j.id}`).get()).data()!;
  const { sourceMatchesSentences } = await import('../../../src/import-reading-analysis.js');
  assert.equal(sourceMatchesSentences(text, s.paragraphs.flatMap((p: any) => p.sentences).map((v: any) => v.text)), true);
  assert.equal(s.analysisProgress.chunks.join(''), text);
  assert.equal(s.analysisProgress.nextChunk, j.totalBatches);
  const bytes = Buffer.byteLength(JSON.stringify(s)); assert.ok(bytes < 900_000);
  console.log(JSON.stringify({ mockLargeSource: true, sourceCharacters: text.length, batches: j.totalBatches, sentences: j.completedSentences, savedBytes: bytes, elapsedMs: Math.round(performance.now() - started) }));
});

test('a dense 8000-character source hitting the document limit retains committed work and unprocessed original text', async () => {
  const text = '甲乙丙丁戊己庚辛壬癸。'.repeat(800).slice(0, 8000);
  let j = await make(text);
  await jobs.runAnalysisTask(payload(j)); j = (await jobs.getAnalysisJob(j.id))!;
  const ref = db.doc(`import_sessions/${j.id}`), before = (await ref.get()).data()!;
  assert.equal(before.analysisProgress.nextChunk, 1);
  const leased = (await jobs.claimAnalysisJob(payload(j)))!;
  const source = leased.chunks[leased.nextBatch];
  // Valid source-aligned analysis with unusually verbose contextual glosses.
  const { normalizeAnalysis } = await import('../../../src/import-analysis.js');
  const sentences = [...new Intl.Segmenter('zh', { granularity: 'sentence' }).segment(source)].map(s => ({ text: s.segment.trim(), explanationLanguage: 'ja', grammar: [], words: [
    { term: '甲', surface: '甲', occurrence: 0, transliteration: 'jiǎ', meaning: '長い文脈説明'.repeat(1000) },
  ] }));
  const analysis = normalizeAnalysis(JSON.stringify({ paragraphs: [{ sentences }] }), 'chinese').analysis;
  const result = { analysis, existing: {}, existingGrammar: {} };
  await assert.rejects(jobs.commitAnalysisResult(leased, result), /too large/i);
  const stopped = (await jobs.failAnalysisJob(leased, new Error('IMPORT_STORAGE_LIMIT')))!;
  assert.equal(stopped.state, 'failed'); assert.equal(stopped.error?.retryable, false);
  const after = (await ref.get()).data()!;
  assert.deepEqual(after.items, before.items); assert.deepEqual(after.paragraphs, before.paragraphs);
  assert.equal(after.analysisProgress.nextChunk, 1);
  assert.equal(after.analysisProgress.chunks.join(''), text);
  assert.ok(after.analysisProgress.chunks.slice(1).join('').length > 0);
  assert.deepEqual(after.groupBNames, before.groupBNames);
});

test('progress is fenced by attempt, never changes the session revision, and SSE recovers the current snapshot', async () => {
  const j = await make(); const first = (await jobs.claimAnalysisJob(payload(j)))!;
  const progress = { ...first.progress!, stage: 'generating' as const, receivedCharacters: 123, lastReceivedAt: new Date().toISOString() };
  await jobs.saveAnalysisProgress(first, progress);
  const current = (await jobs.getAnalysisJob(j.id))!;
  assert.equal(current.progress?.receivedCharacters, 123); assert.equal(current.revision, first.revision);
  const session = (await db.doc(`import_sessions/${j.id}`).get()).data()!;
  assert.equal(session.analysisRevision, first.revision);
  await db.doc(`import_analysis_jobs/${j.id}`).update({ lease: { ...first.lease!, until: 0 } });
  const second = (await jobs.claimAnalysisJob(payload(current)))!;
  await jobs.saveAnalysisProgress(first, { ...progress, receivedCharacters: 999 });
  assert.equal((await jobs.getAnalysisJob(j.id))!.progress!.receivedCharacters, 0);
  await jobs.saveAnalysisProgress(second, progress);
  // A terminal snapshot is replayed immediately on each connection through the real route.
  await jobs.failAnalysisJob(second, Object.assign(new Error('bad configuration'), { status: 401 }));
  for (let i = 0; i < 2; i++) {
    const response = await app.inject(`/api/import/chinese/sessions/${j.id}/analysis-job/events`);
    assert.equal(response.statusCode, 200); assert.match(response.headers['content-type']!, /text\/event-stream/);
    assert.match(response.body, /"receivedCharacters":123/); assert.match(response.body, /"state":"failed"/);
    assert.doesNotMatch(response.body, /mock-model|snapshot/);
  }
  const wrongLanguage = await app.inject(`/api/import/english/sessions/${j.id}/analysis-job/events`);
  assert.equal(wrongLanguage.statusCode, 404);
});
