import { apiFetch } from './transport';
import { notifyIfUnauthorized } from './client';
export interface EventConnection {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}
/** Streaming SSE decoder: CR/LF, UTF-8 boundaries and multi-line data are independent of fetch chunks. */
export async function readSSE(body: ReadableStream<Uint8Array>, receive: (data: string, event: string, id: string) => void) {
  const reader = body.getReader(); const decoder = new TextDecoder();
  let buffer = '', data: string[] = [], event = '', id = '';
  function line(value: string) {
    if (value === '') { if (data.length) receive(data.join('\n'), event || 'message', id); data = []; event = ''; return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'); const key = colon < 0 ? value : value.slice(0, colon);
    const raw = colon < 0 ? '' : value.slice(colon + 1); const content = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (key === 'data') data.push(content);
    if (key === 'event') event = content;
    if (key === 'id' && !content.includes('\0')) id = content;
  }
  function parse(eof = false) {
    let i = 0, start = 0;
    while (i < buffer.length) {
      if (buffer[i] !== '\r' && buffer[i] !== '\n') { i++; continue; }
      if (buffer[i] === '\r' && i + 1 === buffer.length && !eof) break;
      line(buffer.slice(start, i));
      if (buffer[i] === '\r' && buffer[i + 1] === '\n') i++;
      start = ++i;
    }
    buffer = buffer.slice(start);
    // Per SSE semantics, an unterminated event at EOF is discarded.
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true }); parse(done);
      if (done) return;
      if (buffer.length > 2_000_000) throw new Error('SSE frame too large');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Reconnect belongs to the durable-job hook (which re-reads saved state), not this reader. */
export function fetchEventConnection(path: string): EventConnection {
  const abort = new AbortController();
  const connection: EventConnection = { onopen: null, onmessage: null, onerror: null, close: () => abort.abort() };
  void (async () => {
    try {
      const res = await apiFetch(path, { signal: abort.signal, headers: { Accept: 'text/event-stream' } });
      notifyIfUnauthorized(res);
      if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Event stream unavailable');
      connection.onopen?.(new Event('open'));
      await readSSE(res.body, (data, event, id) => {
        if (!abort.signal.aborted && event === 'message') connection.onmessage?.(new MessageEvent('message', { data, lastEventId: id }));
      });
      if (!abort.signal.aborted) connection.onerror?.(new Event('error'));
    } catch { if (!abort.signal.aborted) connection.onerror?.(new Event('error')); }
  })();
  return connection;
}
