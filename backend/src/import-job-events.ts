import { PassThrough } from 'node:stream';
import { jobActive, jobSummary, type ImportJob } from './import-jobs.js';

type Subscribe = (next: (job: ImportJob | null) => void, error: () => void) => () => void;
/** Each short-lived connection rechecks cookie auth. Slow clients reconnect from the latest snapshot. */
export function createImportJobEventStream(subscribe: Subscribe, lifetimeMs = 55_000, heartbeatMs = 15_000) {
  const stream = new PassThrough();
  let closed = false, unsubscribe = () => {};
  const finish = () => {
    if (closed) return;
    closed = true; clearTimeout(lifetime); clearInterval(heartbeat); unsubscribe(); stream.end();
  };
  const send = (data: string) => {
    if (!closed && !stream.write(data)) finish();
  };
  const lifetime = setTimeout(finish, lifetimeMs); lifetime.unref();
  const heartbeat = setInterval(() => send(': heartbeat\n\n'), heartbeatMs); heartbeat.unref();
  stream.once('close', finish);
  send('retry: 1000\n\n');
  try {
    unsubscribe = subscribe(job => {
      if (closed) return;
      if (!job) { finish(); return; }
      send(`data: ${JSON.stringify(jobSummary(job))}\n\n`);
      if (!jobActive(job.state)) finish();
    }, finish);
    if (closed) unsubscribe();
  } catch { finish(); }
  return stream;
}
