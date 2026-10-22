import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { openSSE } from './sse.js';
test('raw SSE preserves CORS headers for WKWebView while rejecting untrusted origins', async () => {
  const app = Fastify(); await app.register(cors, { origin: ['capacitor://localhost'], credentials: true });
  app.post('/stream', async (req, reply) => { const sse = openSSE(req, reply); sse.sendEvent('chunk', { text: '日本語' }); sse.close(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(address + '/stream', { method: 'POST', headers: { origin: 'capacitor://localhost' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), 'capacitor://localhost');
    assert.match(response.headers.get('content-type')!, /text\/event-stream/); assert.match(await response.text(), /日本語/);
    const denied = await fetch(address + '/stream', { method: 'POST', headers: { origin: 'https://evil.invalid' } });
    await denied.text(); assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally { await app.close(); }
});
