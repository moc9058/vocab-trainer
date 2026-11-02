import { CloudTasksClient } from '@google-cloud/tasks';
import { OAuth2Client } from 'google-auth-library';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Firestore } from '@google-cloud/firestore';
import { LibraryOAuth } from './oauth.js';
import { IntegrationOperationStore, type IntegrationOperation } from './operations.js';
import { commitMutation, prepareMutation, DomainError, type PreparedMutation } from './domain.js';
import { operationScopes } from './service.js';
import { refreshWordLibraryMetadata } from '../firestore.js';
import { withLLMBudget } from '../llm-budget.js';
const verifier = new OAuth2Client();
let tasks: CloudTasksClient | undefined;
export function integrationJobsConfigured() { return !!process.env.FIRESTORE_EMULATOR_HOST || ['INTEGRATION_TASK_QUEUE','INTEGRATION_TASK_PROJECT','INTEGRATION_WORKER_URL','INTEGRATION_TASK_ACCOUNT'].every(k => !!process.env[k]); }
export async function verifyIntegrationWorker(request: FastifyRequest) {
  if (process.env.FIRESTORE_EMULATOR_HOST) return false;
  const audience = process.env.INTEGRATION_WORKER_URL, account = process.env.INTEGRATION_TASK_ACCOUNT;
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!audience || !account || !token) return false;
  try { const ticket = await verifier.verifyIdToken({ idToken: token, audience }); const p = ticket.getPayload();
    return !!p && ['accounts.google.com','https://accounts.google.com'].includes(p.iss) && p.email === account && p.email_verified === true;
  } catch { return false; }
}
export async function runIntegrationOperation(db: Firestore, oauth: LibraryOAuth, id: string, log: FastifyBaseLogger) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new DomainError('INVALID_OPERATION');
  const initial = (await db.collection('integration_operations').doc(id).get()).data() as IntegrationOperation | undefined;
  if (!initial) return;
  const store = new IntegrationOperationStore(db);
  const identity = { id: initial.principalId, connectionId: initial.connectionId, scopes: [] as string[] };
  const op = await store.claim(identity,initial.operationId);
  if (!op) return;
  try {
    if (!op.coreCommitted) {
      const principal = await oauth.principal(op.connectionId);
      const scopes = operationScopes(op.action,op.input as Record<string,unknown>);
      if (!principal || principal.id !== op.principalId || scopes.some(s => !principal.scopes.includes(s))) throw new DomainError('FORBIDDEN');
      const prepared = op.checkpoint as PreparedMutation | undefined ?? await withLLMBudget(540000,undefined,() => prepareMutation(op,db,log));
      if (!op.checkpoint) await store.saveCheckpoint(identity,op.operationId,op.generation,prepared);
      await store.commitCore(identity,op.operationId,op.generation,async tx => {
        const conn = (await tx.get(db.collection('integration_connections').doc(op.connectionId))).data();
        if (!conn?.enabled || conn.principalId !== op.principalId || conn.expiresAt <= Date.now() || !oauth.allowed(conn.email) || scopes.some(s => !conn.scopes.includes(s))) throw new DomainError('FORBIDDEN');
        return commitMutation(db,tx,op,prepared);
      });
    }
    if (op.action.endsWith('word') || (op.input as Record<string,unknown>).kind === 'word') await refreshWordLibraryMetadata('chinese');
    await store.complete(identity,op.operationId,op.generation);
  } catch (error) {
    const value = error as { code?: string | number; statusCode?: number; retryable?: boolean };
    const code = typeof value.code === 'string' && /^[A-Z_]+$/.test(value.code) ? value.code : value.statusCode === 409 ? 'DUPLICATE_ITEM' : value.statusCode === 400 ? 'VALIDATION_ERROR' : 'TEMPORARILY_UNAVAILABLE';
    const retryable = value.retryable ?? (value.statusCode === 502 || value.statusCode === 500 || typeof value.code === 'number' && [4,8,10,13,14].includes(value.code) || code === 'TEMPORARILY_UNAVAILABLE');
    await store.fail(identity,op.operationId,op.generation,code,retryable);
    log.warn({ operationId: op.operationId, code },'Integration operation failed');
  }
}
export async function reconcileIntegrationOperations(db: Firestore, oauth: LibraryOAuth, log: FastifyBaseLogger, local = false) {
  if (!integrationJobsConfigured()) return 0;
  await new IntegrationOperationStore(db).reapExpired();
  const due = await db.collection('integration_dispatch_outbox').where('nextWakeAt','<=',Date.now()).limit(50).get();
  let count = 0;
  for (const entry of due.docs) {
    const opRef = db.collection('integration_operations').doc(entry.id);
    const op = (await opRef.get()).data() as IntegrationOperation | undefined;
    if (!op || op.status === 'failed' || op.status === 'succeeded') continue;
    if (op.status === 'running' && op.leaseUntil > Date.now()) continue;
    if (local) { await runIntegrationOperation(db,oauth,entry.id,log); count++; continue; }
    if (process.env.FIRESTORE_EMULATOR_HOST) continue;
    try {
      tasks ??= new CloudTasksClient();
      const parent = tasks.queuePath(process.env.INTEGRATION_TASK_PROJECT!,process.env.INTEGRATION_TASK_REGION ?? 'asia-northeast1',process.env.INTEGRATION_TASK_QUEUE!);
      const taskName = `${parent}/tasks/integration-${entry.id}-${op.generation}-${Math.floor(Date.now()/60000)}`;
      try { await tasks.createTask({ parent, task: { name: taskName, dispatchDeadline: { seconds: 600 }, httpRequest: {
        httpMethod: 'POST', url: `${process.env.INTEGRATION_WORKER_URL}/internal/integration-operations/run`,
        headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ id: entry.id })).toString('base64'),
        oidcToken: { serviceAccountEmail: process.env.INTEGRATION_TASK_ACCOUNT!, audience: process.env.INTEGRATION_WORKER_URL! },
      } } },{ timeout: 3000, retry: null }); } catch (e) { if ((e as {code?:number}).code !== 6) throw e; }
      // A late dispatcher must never recreate an outbox entry deleted by completed work.
      await db.runTransaction(async tx => { const current = await tx.get(entry.ref); if (current.exists) tx.update(entry.ref,{ nextWakeAt: Date.now()+90000 }); });
      count++;
    } catch { log.warn({ operationId: op.operationId },'Integration dispatch pending'); }
  }
  return count;
}
