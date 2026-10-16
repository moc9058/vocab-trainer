// Uses HTTP end-to-end. Production opt-in creates one dedicated source, never registers vocabulary, then deletes it.
import './_project-env.js';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://localhost:5173';
const production = new URL(base).hostname !== 'localhost' && new URL(base).hostname !== '127.0.0.1';
if (production && !process.argv.includes('--allow-production')) throw new Error('Production smoke requires --allow-production');
const sourcePath = process.argv.find(arg => arg.startsWith('--source='))?.slice(9);
const source = sourcePath ? await readFile(sourcePath, 'utf8') : '这是一次部署测试。';
let cookie = '';
if (production) {
  const { loadAuthConfig, signSession, SESSION_COOKIE } = await import('../src/auth-config.js');
  const cfg = await loadAuthConfig();
  if (!cfg) throw new Error('Production auth must be enabled');
  const account = execFileSync('gcloud', ['config', 'get-value', 'account'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase();
  if (!cfg.allowedEmails.includes(account)) throw new Error('Current gcloud account is not an allowed app user');
  cookie = `${SESSION_COOKIE}=${signSession({ email: account }, cfg.sessionSecret)}`;
}
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Smoke API ${method} ${path}: ${res.status}`);
  return res.status === 204 ? null : res.json() as Promise<any>;
}
let id: string | undefined;
try {
  const s = await api('/api/import/chinese/sessions', { title: 'Dedicated durable import deployment smoke', text: source, paragraphs: [], items: [], groupBNames: [], focusedSentenceIndex: 0, status: 'in-progress', analyzeAsJob: true });
  id = s.id; const path = `/api/import/chinese/sessions/${id}`;
  const start = Date.now(), key = crypto.randomUUID();
  const job = await api(path + '/analysis-job', { idempotencyKey: key, analysisRevision: 0 });
  console.log(JSON.stringify({ acceptedMs: Date.now() - start, id, batches: job.totalBatches, sourceLength: source.length }));
  const repeat = await api(path + '/analysis-job', { idempotencyKey: key, analysisRevision: 0 });
  if (repeat.id !== job.id) throw new Error('Duplicate job created');
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await api(path + '/analysis-job');
    if (i % 6 === 0 || !['queued', 'running'].includes(status.state)) console.log(JSON.stringify({ elapsedMs: Date.now() - start, state: status.state, completed: status.nextBatch, batches: status.totalBatches }));
    if (status.state === 'completed') {
      const read = await api(path);
      if (read.analysisProgress.nextChunk !== read.analysisProgress.chunks.length || read.text !== source || !read.items.length) throw new Error('Incomplete saved result');
      const replay = await api(path + '/analysis-job/resume', { idempotencyKey: crypto.randomUUID() });
      if (replay.state !== 'completed') throw new Error('Resume reopened completed job');
      console.log(JSON.stringify({ ok: true, sentences: read.paragraphs.flatMap((p: any) => p.sentences).length, items: read.items.length }));
      break;
    }
    if (status.state === 'failed') throw new Error(`Analysis failed: ${status.error?.code}`);
    if (i === 119) throw new Error('Smoke wait expired');
  }
} finally {
  if (id) { await api(`/api/import/chinese/sessions/${id}`, undefined, 'DELETE'); console.log('Dedicated smoke source deleted; no library registrations were made.'); }
}
