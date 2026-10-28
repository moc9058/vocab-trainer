import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
if (process.env.FIRESTORE_PROJECT !== 'demo-vocab-math' || !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Source tests require isolated demo math emulator');
const { collection, mathDb, writeChunks } = await import('../../../src/math-store.js');
const { saveJsonSource, loadSourceArtifact } = await import('../../../src/math-source-store.js');
const { contentHash } = await import('../../../src/math-schema.js');
test('chunked JSON source is immutable, aliases preserve exact historical body after deletion', async () => {
  const markdown = `# Historical ${randomUUID()}\n\n$F=\\mathbb{R}$\n`;
  const legacyHash = contentHash(markdown);
  await collection('source_revisions').doc(legacyHash).create({ markdown });
  const before = await loadSourceArtifact(legacyHash) as any;
  assert.equal(before.content[0].text, markdown);
  const sha256 = createHash('sha256').update(markdown).digest('hex');
  const value = { schemaVersion: 2, format: 'legacy-source', originalHash: legacyHash, source: { originalSha256: sha256 }, content: before.content };
  const hashes = await Promise.all([saveJsonSource(value), saveJsonSource(value)]);
  const jsonHash = hashes[0];
  assert.equal(hashes[1], jsonHash);
  assert.equal(await saveJsonSource(value), jsonHash);
  await collection('source_aliases').doc(legacyHash).create({ jsonHash, originalSha256: sha256, migrationVersion: 2 });
  await collection('source_revisions').doc(legacyHash).delete();
  assert.deepEqual(await loadSourceArtifact(legacyHash), value);
  const aliasRef = collection('source_aliases').doc(legacyHash);
  await aliasRef.update({ originalSha256: '0'.repeat(64) });
  await assert.rejects(loadSourceArtifact(legacyHash), /MATH_SOURCE_ALIAS_CORRUPT/);
  await aliasRef.update({ originalSha256: sha256 });
  const latestHash = await saveJsonSource({ schemaVersion: 2, title: 'new edition' });
  await aliasRef.update({ jsonHash: latestHash });
  await assert.rejects(loadSourceArtifact(legacyHash), /MATH_SOURCE_ALIAS_CORRUPT/);
  await aliasRef.update({ jsonHash });
  await mathDb.recursiveDelete(collection('source_revisions').doc(latestHash));
  assert.equal((await collection('source_revisions').doc(jsonHash).get()).data()?.markdown, undefined);
  // Corruption cannot pass content-addressed read-back validation.
  await collection('source_revisions').doc(jsonHash).collection('chunks').doc('00000').update({ data: 'broken' });
  await assert.rejects(loadSourceArtifact(legacyHash), /MATH_CHUNK_CORRUPT/);
  await mathDb.recursiveDelete(collection('source_revisions').doc(jsonHash));
  await collection('source_aliases').doc(legacyHash).delete();
});
