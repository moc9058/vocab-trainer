import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIntegrationMcp } from './integrations/mcp.js';

test('MCP negotiates schemas, enforces authorization per call and hides internal errors', async () => {
  let allowed = false;
  let calls = 0;
  const server = createIntegrationMcp({ id: 'owner', connectionId: 'conn', scopes: ['vocab.read'] }, {
    authorize: async (_principal, scopes) => allowed && scopes.every(scope => scope === 'vocab.read'),
    execute: async (_name, input) => { calls++; if ((input as { itemId: string }).itemId === 'limited') throw Object.assign(new Error('secret'),{code:'RATE_LIMITED'}); if ((input as { itemId: string }).itemId === 'bad') throw new Error('secret'); return { id: 'zh-001' }; },
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 17);
    assert.equal(list.tools.find(tool => tool.name === 'delete_word')?.annotations?.destructiveHint, true);
    assert.equal((await client.callTool({ name: 'get_word', arguments: { itemId: 'zh-001' } })).isError, true);
    assert.equal(calls, 0);
    allowed = true;
    assert.deepEqual((await client.callTool({ name: 'get_word', arguments: { itemId: 'zh-001' } })).structuredContent, { id: 'zh-001' });
    assert.equal((await client.callTool({ name: 'delete_word', arguments: { itemId: 'zh-001', operationId: 'f6c2e6bc-3189-42e1-93e9-93aefda6c915', expectedVersion: 'v1' } })).isError, true);
    const error = await client.callTool({ name: 'get_word', arguments: { itemId: 'bad' } });
    assert.equal(error.isError, true);
    assert.ok(!JSON.stringify(error).includes('secret'));
    const limited = await client.callTool({ name: 'get_word', arguments: { itemId: 'limited' } });
    assert.equal(limited.isError,true);
    const text = limited.content as {type:string;text:string}[];
    assert.deepEqual(JSON.parse(text[0].text),limited.structuredContent);
    assert.equal((limited.structuredContent as any).error.code,'RATE_LIMITED');
    assert.equal((limited.structuredContent as any).error.retryAfterMs,60000);
    allowed = false;
    assert.equal((await client.callTool({ name: 'get_word', arguments: { itemId: 'zh-001' } })).isError, true);
  } finally { await client.close(); await server.close(); }
});
