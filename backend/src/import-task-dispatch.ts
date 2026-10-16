import { CloudTasksClient } from '@google-cloud/tasks';
import { OAuth2Client } from 'google-auth-library';
import type { FastifyRequest } from 'fastify';
import type { ImportJob } from './import-jobs.js';

let client: CloudTasksClient | undefined;
const verifier = new OAuth2Client();
export const localJobs = () => !!process.env.FIRESTORE_EMULATOR_HOST;
export function jobsConfigured(): boolean {
  return localJobs() || ['IMPORT_TASK_QUEUE', 'IMPORT_WORKER_URL', 'IMPORT_TASK_ACCOUNT', 'IMPORT_TASK_PROJECT'].every(k => !!process.env[k]);
}
export async function verifyImportWorker(request: FastifyRequest): Promise<boolean> {
  // No network-accessible emulator auth bypass: local runner calls functions directly.
  if (localJobs()) return false;
  const audience = process.env.IMPORT_WORKER_URL;
  const account = process.env.IMPORT_TASK_ACCOUNT;
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!audience || !account || !token) return false;
  try {
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const data = ticket.getPayload();
    return !!data && ['accounts.google.com', 'https://accounts.google.com'].includes(data.iss)
      && data.email === account && data.email_verified === true;
  } catch { return false; }
}
export function dispatchId(job: ImportJob): string {
  return `import-${job.id}-${job.generation}-${job.nextBatch}-${job.sequence}`;
}
export async function enqueueImportJob(job: ImportJob): Promise<void> {
  if (localJobs()) return; // A separate local worker polls durable nextWakeAt entries.
  if (!jobsConfigured()) throw new Error('Import worker configuration is missing');
  client ??= new CloudTasksClient();
  const parent = client.queuePath(process.env.IMPORT_TASK_PROJECT!, process.env.IMPORT_TASK_REGION ?? 'asia-northeast1', process.env.IMPORT_TASK_QUEUE!);
  const name = `${parent}/tasks/${dispatchId(job)}`;
  try {
    await client.createTask({ parent, task: { name, dispatchDeadline: { seconds: 600 },
      scheduleTime: { seconds: Math.floor(Math.max(Date.now(), job.nextWakeAt) / 1000) },
      httpRequest: { httpMethod: 'POST', url: `${process.env.IMPORT_WORKER_URL}/internal/import-analysis/run`,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ jobId: job.id, generation: job.generation, batch: job.nextBatch, sequence: job.sequence })).toString('base64'),
        oidcToken: { serviceAccountEmail: process.env.IMPORT_TASK_ACCOUNT!, audience: process.env.IMPORT_WORKER_URL! } } } }, { timeout: 3000, retry: null });
  } catch (err) {
    if ((err as { code?: number }).code !== 6) throw err; // ALREADY_EXISTS: acknowledgement was lost.
  }
}
