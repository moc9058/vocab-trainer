import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { OAuth2Client } from 'google-auth-library';
import { verifyImportWorker } from './import-task-dispatch.js';
import type { FastifyRequest } from 'fastify';
const env = { ...process.env };
delete process.env.FIRESTORE_EMULATOR_HOST;
process.env.IMPORT_WORKER_URL = 'https://worker.example';
process.env.IMPORT_TASK_ACCOUNT = 'worker@example.iam.gserviceaccount.com';
let payload: any = { iss: 'https://accounts.google.com', email: process.env.IMPORT_TASK_ACCOUNT, email_verified: true };
const verify = mock.method(OAuth2Client.prototype, 'verifyIdToken', async (options: any) => {
  assert.equal(options.audience, 'https://worker.example');
  if (options.idToken !== 'valid-signed-token') throw new Error('Invalid signature or expired token');
  return { getPayload: () => payload } as any;
});
const request = (headers: Record<string, string>) => ({ headers }) as FastifyRequest;
test('worker requires verified Google OIDC with exact audience and allowed service account', async () => {
  assert.equal(await verifyImportWorker(request({ 'x-cloudtasks-taskname': 'fake', cookie: 'vt_session=not-enough' })), false);
  assert.equal(await verifyImportWorker(request({ authorization: 'Bearer forged-or-expired' })), false);
  assert.equal(await verifyImportWorker(request({ authorization: 'Bearer valid-signed-token' })), true);
  payload.email = 'other@example.iam.gserviceaccount.com'; assert.equal(await verifyImportWorker(request({ authorization: 'Bearer valid-signed-token' })), false);
  payload.email = process.env.IMPORT_TASK_ACCOUNT; payload.iss = 'https://untrusted.example'; assert.equal(await verifyImportWorker(request({ authorization: 'Bearer valid-signed-token' })), false);
  payload.iss = 'accounts.google.com'; payload.email_verified = false; assert.equal(await verifyImportWorker(request({ authorization: 'Bearer valid-signed-token' })), false);
  delete process.env.IMPORT_TASK_ACCOUNT; assert.equal(await verifyImportWorker(request({ authorization: 'Bearer valid-signed-token' })), false);
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'; assert.equal(await verifyImportWorker(request({ authorization: 'Bearer valid-signed-token' })), false);
});
after(() => { verify.mock.restore(); for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); });
