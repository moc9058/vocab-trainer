import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const value = { schemaVersion: 2, format: 'legacy-source', content: before.content };
  const jsonHash = await saveJsonSource(value);
  assert.equal(await saveJsonSource(value), jsonHash);
  await collection('source_aliases').doc(legacyHash).create({ jsonHash, originalSha256: legacyHash, migrationVersion: 2 });
  await collection('source_revisions').doc(legacyHash).delete();
  assert.deepEqual(await loadSourceArtifact(legacyHash), value);
  assert.equal((await collection('source_revisions').doc(jsonHash).get()).data()?.markdown, undefined);
  // Corruption cannot pass content-addressed read-back validation.
  await collection('source_revisions').doc(jsonHash).collection('chunks').doc('00000').update({ data: 'broken' });
  await assert.rejects(loadSourceArtifact(legacyHash), /MATH_CHUNK_CORRUPT/);
  await mathDb.recursiveDelete(collection('source_revisions').doc(jsonHash));
  await collection('source_aliases').doc(legacyHash).delete();
});
