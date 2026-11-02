import { execFileSync } from 'node:child_process';
const project = process.argv[2], region = process.argv[3];
if (!project || !region || !/^[a-z0-9-]+$/.test(project + region)) throw new Error('Project and region are required');
const windows = process.platform === 'win32';
function run(args) {
  const safe = [...args, `--project=${project}`, '--quiet'];
  if (safe.some(a => /["&|<>^%!]/.test(a))) throw new Error('Unsafe gcloud argument');
  return execFileSync(windows ? 'gcloud.cmd' : 'gcloud', windows ? safe.map(a => `"${a}"`) : safe, { encoding: 'utf8', shell: windows, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const service = JSON.parse(run(['run', 'services', 'describe', 'vocab-trainer-backend', `--region=${region}`, '--format=json']));
const env = Object.fromEntries((service.spec.template.spec.containers[0].env ?? []).filter(e => e.name.startsWith('INTEGRATION')).map(e => [e.name, e.value]));
if (env.INTEGRATIONS_ENABLED !== 'true') { console.log('ChatGPT integration is disabled; no integration infrastructure check needed.'); process.exit(0); }
if (!['INTEGRATION_TASK_PROJECT', 'INTEGRATION_TASK_QUEUE', 'INTEGRATION_TASK_REGION', 'INTEGRATION_TASK_ACCOUNT', 'INTEGRATION_WORKER_URL'].every(k => env[k])) throw new Error('Durable import infrastructure is missing. Run: npx --prefix backend tsx backend/scripts/setup-integration-jobs.ts PROJECT REGION');
if (env.INTEGRATION_TASK_PROJECT !== project || env.INTEGRATION_TASK_REGION !== region || env.INTEGRATION_WORKER_URL !== service.status.url) throw new Error('Integration worker configuration does not match the deployment');
const queue = JSON.parse(run(['tasks', 'queues', 'describe', env.INTEGRATION_TASK_QUEUE, `--location=${region}`, '--format=json']));
if (queue.state !== 'RUNNING' || queue.rateLimits.maxConcurrentDispatches !== 1) throw new Error('Integration queue must be running with concurrency 1');
const scheduler = JSON.parse(run(['scheduler', 'jobs', 'describe', 'integration-operations-reconcile', `--location=${region}`, '--format=json']));
if (scheduler.state !== 'ENABLED' || scheduler.httpTarget?.oidcToken?.serviceAccountEmail !== env.INTEGRATION_TASK_ACCOUNT || scheduler.httpTarget?.oidcToken?.audience !== env.INTEGRATION_WORKER_URL || scheduler.httpTarget?.uri !== env.INTEGRATION_WORKER_URL + '/internal/integration-operations/reconcile') throw new Error('Integration recovery scheduler/OIDC configuration is invalid');
console.log('Durable integration deployment prerequisites verified.');
