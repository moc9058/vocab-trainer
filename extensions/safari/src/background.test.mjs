import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const routes = JSON.parse(readFileSync(new URL('../../../backend/src/extension-routes.json', import.meta.url)));
function fixture() {
  const values = new Map(); let listener, fetches = [], nextTab = 50;
  const panel = 'safari-web-extension://extension/panel.html';
  const browser = { action: { onClicked: { addListener() {} } }, runtime: { id: 'extension', getURL: () => panel,
    onMessage: { addListener(fn) { listener = fn; } },
    async sendNativeMessage(host, { action, key, value }) {
      if (action === 'read') return { value: values.get(key) ?? null };
      if (action === 'write') values.set(key, structuredClone(value));
      if (action === 'delete') values.delete(key);
      if (action === 'clear') values.clear();
      return { value: null };
    } }, tabs: { async create() { return { id: nextTab++ }; }, async update() {}, async sendMessage() {} } };
  const sandbox = vm.createContext({ browser, crypto: webcrypto, URL, TextEncoder, btoa, EXTENSION_ROUTES: routes,
    async fetch(url, init) { fetches.push({ url, init }); return new Response('{}'); } });
  vm.runInContext(readFileSync(new URL('./policy.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(readFileSync(new URL('./background.js', import.meta.url), 'utf8'), sandbox);
  return { send: (message, sender) => listener(message, sender), values, fetches, panel };
}
const content = { id: 'extension', tab: { id: 1 }, frameId: 0, url: 'https://example.org/article?private=1' };
test('content scripts cannot obtain tokens or invoke API/registration/auth messages', async () => {
  const f = fixture(); f.values.set('token', 'secret');
  for (const type of ['api', 'status', 'connect', 'exchange', 'disconnect', 'get-context', 'save-operation', 'detach']) {
    const r = await f.send({ type, path: '/api/vocab/chinese/smart-add', method: 'POST', body: '{}' }, content);
    assert.ok(r.error, type); assert.ok(!JSON.stringify(r).includes('secret'));
  }
  for (const type of ['api', 'status', 'connect', 'exchange', 'disconnect']) {
    const result = await f.send({ type, path: '/api/grammar/settings', method: 'GET' }, { id: 'extension', url: f.panel, tab: { id: 9 }, frameId: 0 });
    assert.ok(result.error, `unbound public HTML: ${type}`);
  }
  assert.equal(f.fetches.length, 0);
});
test('only source top frame can create a selection; public context ID alone cannot bind', async () => {
  const f = fixture();
  assert.ok((await f.send({ type: 'selection', text: '中文' }, { ...content, frameId: 2 })).error);
  assert.ok((await f.send({ type: 'selection', text: '中文' }, { ...content, id: 'fake' })).error);
  const r = await f.send({ type: 'selection', text: '中文', title: 'Article' }, content);
  assert.ok(r.id && r.bind); assert.ok(!r.url.includes('中文'));
  const panel = { id: 'extension', url: r.url, tab: { id: 1 }, frameId: 8 };
  assert.ok((await f.send({ type: 'bind', context: r.id, bind: 'fake' }, panel)).error);
  assert.ok((await f.send({ type: 'bind', context: r.id, bind: r.bind }, { ...panel, tab: { id: 2 } })).error);
  assert.equal((await f.send({ type: 'bind', context: r.id, bind: r.bind }, panel)).ok, true);
  assert.ok((await f.send({ type: 'get-context', context: r.id }, { ...panel, frameId: 9 })).error);
  assert.equal((await f.send({ type: 'get-context', context: r.id }, panel)).text, '中文');
  assert.ok((await f.send({ type: 'fallback', context: r.id, bind: r.bind }, content)).error);
});
test('bound panel uses fixed origin and Bearer, while frozen retries cannot be changed', async () => {
  const f = fixture(); f.values.set('token', 'ext_secret');
  const r = await f.send({ type: 'selection', text: '中文' }, content);
  const panel = { id: 'extension', url: r.url, tab: { id: 1 }, frameId: 8 };
  await f.send({ type: 'bind', context: r.id, bind: r.bind }, panel);
  const request = JSON.stringify({ text: '中文', paragraphs: [], items: [], analyzeAsJob: true, ingestionId: '9e1e5b52-6bb7-4534-9f40-18b77a3e12b5', sourceOrigin: { method: 'safari-selection' } });
  assert.equal((await f.send({ type: 'save-operation', context: r.id, request }, panel)).ok, true);
  assert.ok((await f.send({ type: 'save-operation', context: r.id, request: request.replace('中文', '汉字') }, panel)).error);
  await f.send({ type: 'api', context: r.id, method: 'GET', path: '/api/grammar/settings' }, panel);
  assert.equal(f.fetches.length, 1); assert.ok(f.fetches[0].url.startsWith('https://vocab-trainer-frontend-'));
  assert.equal(f.fetches[0].init.headers.Authorization, 'Bearer ext_secret');
  assert.equal(f.fetches[0].init.credentials, 'omit');
  assert.ok((await f.send({ type: 'api', context: r.id, method: 'POST', path: '/api/math/tests', body: '{}' }, panel)).error);
  await f.send({ type: 'save-operation', context: r.id, sessionId: 'saved' }, panel);
  const saved = await f.send({ type: 'get-context', context: r.id }, panel);
  assert.equal(saved.text, undefined); assert.equal(saved.request, undefined); assert.equal(saved.sessionId, 'saved');
  f.values.get(`ctx-${r.id}`).expiresAt = 1;
  assert.ok((await f.send({ type: 'get-context', context: r.id }, panel)).error);
});
