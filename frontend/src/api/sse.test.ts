import { expect, it } from 'vitest';
import { readSSE } from './sse';
it('parses SSE with UTF-8 and CRLF split across individual bytes', async () => {
  const text = ': heartbeat\r\nid: 7\r\nevent: message\r\ndata: 日本語\r\ndata: second\r\n\r\ndata: next\n\ndata: incomplete';
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
  const events: unknown[] = []; await readSSE(body, (...args) => events.push(args));
  expect(events).toEqual([['日本語\nsecond', 'message', '7'], ['next', 'message', '7']]);
});
