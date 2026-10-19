import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImportJobEventStream } from './import-job-events.js';
import type { ImportJob } from './import-jobs.js';
const job = { id: 'one', generation: 1, state: 'running', revision: 2, nextBatch: 1, totalBatches: 2,
  completedSentences: 2, pauseRequested: false, updatedAt: '', attempts: 1, chunks: ['短。', '長い文章。'], snapshot: { system: 'PRIVATE', model: '', schema: {} } } as ImportJob;
test('SSE sends safe snapshots, updated progress, terminal state and releases its subscription', async () => {
  let next!: (job: ImportJob | null) => void, unsubscribed = 0;
  const stream = createImportJobEventStream(listener => { next = listener; return () => { unsubscribed++; }; });
  next(job);
  next({ ...job, state: 'completed', nextBatch: 2 });
  let body = ''; for await (const chunk of stream) body += chunk;
  assert.match(body, /"completedCharacters":2/);
  assert.match(body, /"totalCharacters":7/);
  assert.match(body, /"state":"completed"/);
  assert.doesNotMatch(body, /PRIVATE|snapshot|短/);
  assert.equal(unsubscribed, 1);
});
test('disconnects, missing jobs and subscription errors release Firestore listeners', async () => {
  for (const mode of ['disconnect', 'missing', 'error']) {
    let next!: (job: ImportJob | null) => void, error!: () => void, unsubscribed = 0;
    const stream = createImportJobEventStream((listener, fail) => { next = listener; error = fail; return () => { unsubscribed++; }; });
    const closed = new Promise(resolve => stream.once('close', resolve));
    if (mode === 'disconnect') stream.destroy();
    else { stream.resume(); if (mode === 'missing') next(null); else error(); }
    await closed; assert.equal(unsubscribed, 1);
  }
});
test('bounded connection lifetime releases its listener even without job changes', async () => {
  let unsubscribed = 0;
  const stream = createImportJobEventStream(() => () => { unsubscribed++; }, 10, 3);
  // Keep the test runner alive while the unref'ed production timer expires.
  const keepAlive = setTimeout(() => {}, 1000);
  let body = ''; for await (const chunk of stream) body += chunk;
  clearTimeout(keepAlive);
  assert.match(body, /heartbeat/); assert.equal(unsubscribed, 1);
});
