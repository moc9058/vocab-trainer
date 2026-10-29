import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const routes = JSON.parse(readFileSync(new URL('../../../backend/src/extension-routes.json', import.meta.url)));
const sandbox = vm.createContext({ URL, TextEncoder, EXTENSION_ROUTES: routes });
vm.runInContext(readFileSync(new URL('./policy.js', import.meta.url), 'utf8'), sandbox);
const { validSelection, sourceDetails, allowedApi } = sandbox;
test('selection preserves exact UTF-16 input, including emoji and combining marks', () => {
  for (const s of ['', ' ', '\n\t']) assert.equal(validSelection(s), false);
  for (const s of ['繁體与简体\n第二行', '字'.repeat(7998) + '😀', 'a\u0301'.repeat(4000)]) assert.equal(validSelection(s), true);
  for (const s of ['字'.repeat(7999) + '😀', '字'.repeat(8001)]) assert.equal(validSelection(s), false);
});
test('source metadata drops private URL parts without inventing HTTPS', () => {
  const s = sourceDetails('https://name:secret@example.org/a?q=private#fragment', 'a\nTitle');
  assert.equal(s.sourceUrl, 'https://example.org/a'); assert.equal(s.sourceLabel, 'aTitle');
  assert.equal(sourceDetails('http://example.org/a', 'x').sourceUrl, undefined);
  assert.equal(sourceDetails('https://example.org', 'x'.repeat(101)).sourceLabel.length, 100);
});
test('capabilities deny arbitrary origins, traversal, other languages and administrative writes', () => {
  for (const p of ['https://evil.example/api/vocab/chinese/smart-add', '/api/math/textbooks', '/api/quiz/chinese', '/api/grammar/settings', '/api/llm-config', '/api/vocab/japanese/smart-add', '/api/import/chinese/sessions/%2e%2e', '/api/import/chinese/sessions/..', '/api/auth/extension/connections/revoke']) assert.equal(allowedApi('POST', p, '{}'), false, p);
  assert.equal(allowedApi('GET', '/api/grammar/settings'), true);
  assert.equal(allowedApi('GET', '/api/grammar/settings', '{}'), false);
  assert.equal(allowedApi('POST', '/api/vocab/chinese/smart-add', 'x'), false);
  assert.equal(allowedApi('POST', '/api/vocab/chinese/smart-add', '[]'), false);
  assert.equal(allowedApi('POST', '/api/vocab/chinese/smart-add', JSON.stringify({ text: '中'.repeat(300001) })), false);
});
test('registration only adds membership and ingestion must use the durable selection contract', () => {
  assert.equal(allowedApi('POST', '/api/vocab/chinese/groups/g/words', '{"wordIds":["w"],"action":"add"}'), true);
  assert.equal(allowedApi('POST', '/api/vocab/chinese/groups/g/words', '{"wordIds":["w"],"action":"remove"}'), false);
  const request = { text: '文章', paragraphs: [], items: [], analyzeAsJob: true, ingestionId: '9e1e5b52-6bb7-4534-9f40-18b77a3e12b5', sourceOrigin: { method: 'safari-selection' } };
  assert.equal(allowedApi('POST', '/api/import/chinese/sessions', JSON.stringify(request)), true);
  assert.equal(allowedApi('POST', '/api/import/chinese/sessions', JSON.stringify({ ...request, text: 'x'.repeat(8001) })), false);
});
