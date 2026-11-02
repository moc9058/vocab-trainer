import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Firestore } from '@google-cloud/firestore';
import { IntegrationOperationStore } from '../../../src/integrations/operations.js';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('An explicit emulator is required');
const db = new Firestore({ projectId: `integration-test-${Date.now()}`, databaseId: 'vocab-database' });
const principal = { id: 'owner', connectionId: 'conn', scopes: ['vocab.write'] };
const operationId = 'f6c2e6bc-3189-42e1-93e9-93aefda6c915';
const input = { operationId, word: { term: '后悔' } };
test('durable receipt and domain commit survive duplicate acceptance, lease expiry and worker restart', async () => {
  let now = Date.now();
  const store = new IntegrationOperationStore(db, () => now);
  try {
    const accepted = await Promise.all([store.accept(principal, 'create_word', input), store.accept(principal, 'create_word', input)]);
    assert.equal(accepted[0].allocatedItemId, accepted[1].allocatedItemId);
    assert.equal((await db.collection('integration_dispatch_outbox').get()).size, 1);
    await assert.rejects(store.accept(principal, 'create_word', { ...input, word: { term: '其他' } }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(await store.get({ ...principal, id: 'other' }, operationId), null);
    const first = await store.claim(principal, operationId, 1000);
    assert.ok(first);
    assert.equal(await store.claim(principal, operationId, 1000), null);
    now += 1001;
    const second = await store.claim(principal, operationId, 1000);
    assert.ok(second);
    await assert.rejects(store.commitCore(principal, operationId, first.generation, async () => ({})), { code: 'LEASE_LOST' });
    let writes = 0;
    const commit = () => store.commitCore(principal, operationId, second.generation, async (tx, op) => {
      writes++; tx.create(db.collection('test_items').doc(op.allocatedItemId), { term: '后悔' }); return { itemId: op.allocatedItemId };
    });
    await commit(); await commit();
    assert.equal(writes, 1);
    now += 1001;
    const restarted = new IntegrationOperationStore(db, () => now);
    const resumed = await restarted.claim(principal, operationId, 1000);
    assert.ok(resumed?.coreCommitted);
    await restarted.complete(principal, operationId, resumed.generation);
    assert.equal((await restarted.get(principal, operationId))?.status, 'succeeded');
    assert.equal((await db.collection('test_items').get()).size, 1);
    assert.equal((await db.collection('integration_dispatch_outbox').get()).size, 0);
    assert.equal(await restarted.claim(principal, operationId), null);
    const failedId = '22a29af9-8db8-4524-aab3-cf7bd7192ab6';
    await restarted.accept(principal,'create_word',{...input,operationId:failedId});
    const failing = await restarted.claim(principal,failedId);
    assert.ok(failing);
    await restarted.fail(principal,failedId,failing.generation,'TEMPORARILY_UNAVAILABLE',true);
    assert.equal((await db.collection('integration_dispatch_outbox').get()).size,0);
    await restarted.retry(principal,failedId);
    assert.equal((await db.collection('integration_dispatch_outbox').get()).size,1);
    now += 31*86400000;
    await restarted.reapExpired();
    assert.equal(await restarted.get(principal,failedId),null);
    assert.equal((await db.collection('integration_dispatch_outbox').get()).size,0);
    await assert.rejects(restarted.accept(principal,'create_word',input),{code:'OPERATION_EXPIRED'});

  } finally { await db.terminate(); }
});
