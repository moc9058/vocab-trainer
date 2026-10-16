import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ImportJob } from '../../src/import-jobs.js';
let captured: any, options: any, error: unknown;
mock.module('@google-cloud/tasks', { namedExports: { CloudTasksClient: class {
  queuePath(project: string, region: string, queue: string) { return `${project}/${region}/${queue}`; }
  async createTask(input: any, settings: any) { captured = input; options = settings; if (error) throw error; return [{}]; }
} } });
const env = { ...process.env };
delete process.env.FIRESTORE_EMULATOR_HOST;
Object.assign(process.env, { IMPORT_TASK_PROJECT: 'demo', IMPORT_TASK_REGION: 'asia-northeast1', IMPORT_TASK_QUEUE: 'import-analysis', IMPORT_WORKER_URL: 'https://worker.example', IMPORT_TASK_ACCOUNT: 'worker@example.iam.gserviceaccount.com' });
const { enqueueImportJob } = await import('../../src/import-task-dispatch.js');
const job = { id: 'session', generation: 1, nextBatch: 2, sequence: 3, nextWakeAt: Date.now() } as ImportJob;
test('queue dispatch is bounded, stable and carries OIDC with only identifiers', async () => {
  await enqueueImportJob(job);
  assert.deepEqual(options, { timeout: 3000, retry: null });
  assert.equal(captured.task.name, 'demo/asia-northeast1/import-analysis/tasks/import-session-1-2-3');
  assert.equal(captured.task.dispatchDeadline.seconds, 600);
  assert.deepEqual(captured.task.httpRequest.oidcToken, { audience: 'https://worker.example', serviceAccountEmail: 'worker@example.iam.gserviceaccount.com' });
  assert.deepEqual(JSON.parse(Buffer.from(captured.task.httpRequest.body, 'base64').toString()), { jobId: 'session', generation: 1, batch: 2, sequence: 3 });
});
test('lost queue acknowledgement is idempotent; other enqueue failures remain recoverable', async () => {
  error = { code: 6 }; await enqueueImportJob(job);
  error = { code: 7 }; await assert.rejects(enqueueImportJob(job));
});
after(() => { for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); });
