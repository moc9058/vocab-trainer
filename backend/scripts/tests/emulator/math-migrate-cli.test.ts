/** CLI maintenance tests use a separate demo project from runtime fixtures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { contentHash } from '../../../src/math-schema.js';
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(localhost|127\.0\.0\.1):\d+$/.test(host)) throw new Error('Migration tests require local emulator');
const project = 'demo-vocab-math-migrate-cli';
const db = new Firestore({ projectId: project, databaseId: '(default)' });
const col = (name: string) => db.collection(`math_${name}`);
const execute = promisify(execFile);
async function run(args: string[]) {
  try {
    const result = await execute(process.execPath, ['--import', 'tsx', 'scripts/math-migrate-json.ts', '--project', project, '--database', '(default)', ...args], {
      env: { ...process.env, FIRESTORE_EMULATOR_HOST: host, FIRESTORE_PROJECT: project, FIRESTORE_DATABASE_ID: '(default)' }, timeout: 30_000, maxBuffer: 2_000_000 });
    return { ...result, code: 0 };
  } catch (error: any) { return { stdout: String(error.stdout), stderr: String(error.stderr), code: error.code }; }
}
async function inventory() {
  const result = await run(['--dry-run']); assert.equal(result.code, 0, result.stderr);
  const hash = result.stdout.match(/"manifestHash": "([a-f0-9]{64})"/)?.[1]; assert.ok(hash, result.stdout);
  return { hash, result };
}
async function reset() { for (const collection of await db.listCollections()) await db.recursiveDelete(collection); }
test('migration CLI guards checksum, worker barrier, resume and deleted-source replay', async () => {
  await reset(); const folder = await mkdtemp(join(tmpdir(), 'math-migrate-cli-'));
  const backup = join(folder, 'backup'), checkpoint = join(folder, 'checkpoint.json');
  const markdown = '# Historic original\n\nAssume $F=\\mathbb{R}$.\n\nPreserve the old edition.\n';
  const legacyHash = contentHash(markdown), sha = createHash('sha256').update(markdown).digest('hex');
  const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'ok', sourceFormats: ['textbook-json'], sourceAliasVersion: 2 })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const health = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await col('source_revisions').doc(legacyHash).create({ markdown });
    await col('unit_revisions').doc('historic-unit').create({ sourceArtifactHash: legacyHash });
    const first = await inventory();
    assert.ok(!first.result.stdout.includes(markdown)); assert.match(first.result.stdout, /"references": 1/);
    assert.equal((await col('source_aliases').get()).size, 0);
    assert.equal((await col('source_revisions').get()).size, 1);
    const args = ['--manifest-hash', first.hash, '--expected-active-catalog-id', 'none', '--backup', backup, '--checkpoint', checkpoint];
    const changedArgs = [...args]; changedArgs[1] = '0'.repeat(64);
    const changed = await run(changedArgs); assert.notEqual(changed.code, 0); assert.match(changed.stderr, /MATH_INVENTORY_CHANGED/);
    await mkdir(backup);
    await writeFile(join(backup, `${legacyHash}.json`), JSON.stringify({ hash: legacyHash, sha256: sha, markdown: 'tampered backup' }));
    const mismatch = await run(args); assert.notEqual(mismatch.code, 0); assert.match(mismatch.stderr, /MATH_BACKUP_HASH_MISMATCH/);
    assert.equal((await col('source_aliases').get()).size, 0);
    await writeFile(join(backup, `${legacyHash}.json`), JSON.stringify({ hash: legacyHash, sha256: sha, markdown }));
    const migrated = await run(args); assert.equal(migrated.code, 0, migrated.stderr);
    const alias = (await col('source_aliases').doc(legacyHash).get()).data()!;
    assert.equal(alias.originalSha256, sha); assert.equal(alias.migrationVersion, 2);
    assert.equal((await col('source_revisions').doc(legacyHash).get()).exists, true);
    const receipt = JSON.parse(await readFile(checkpoint, 'utf8'));
    assert.equal(receipt.target, `${project}/(default)`); assert.equal(receipt.migrated[legacyHash].jsonHash, alias.jsonHash);
    assert.equal((await stat(backup)).mode & 0o777, 0o700); assert.equal((await stat(checkpoint)).mode & 0o777, 0o600);
    const repeat = await run([...args, '--resume']); assert.equal(repeat.code, 0, repeat.stderr);
    await col('jobs').doc('queued-worker').set({ state: 'queued', lease: null });
    const deletion = [...args, '--resume', '--delete-legacy', '--compatible-backend-url', health];
    const blocked = await run(deletion); assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /MATH_WORKER_LEASE_ACTIVE/);
    assert.equal((await col('source_revisions').doc(legacyHash).get()).exists, true);
    await col('jobs').doc('queued-worker').update({ state: 'succeeded' });
    const deleted = await run(deletion); assert.equal(deleted.code, 0, deleted.stderr);
    assert.equal((await col('source_revisions').doc(legacyHash).get()).exists, false); assert.match(deleted.stdout, /"remainingLegacy":0/);
    const after = await inventory(); assert.match(after.result.stdout, /"unresolved": \[\]/);
    const replay = ['--manifest-hash', after.hash, '--expected-active-catalog-id', 'none', '--backup', backup, '--checkpoint', checkpoint, '--resume', '--delete-legacy', '--compatible-backend-url', health];
    const replayed = await run(replay); assert.equal(replayed.code, 0, replayed.stderr);
    await writeFile(join(backup, `${legacyHash}.json`), JSON.stringify({ hash: legacyHash, sha256: sha, markdown: 'changed after deletion' }));
    const badResume = await run(replay); assert.notEqual(badResume.code, 0); assert.match(badResume.stderr, /MATH_BACKUP_HASH_MISMATCH/);
  } finally { server.close(); await once(server, 'close'); await reset(); await rm(folder, { recursive: true, force: true }); }
});
test('migration refuses unresolved references and unexpected active catalog without writing', async () => {
  await reset(); const folder = await mkdtemp(join(tmpdir(), 'math-migrate-unsafe-'));
  try {
    await col('unit_revisions').doc('missing-unit').create({ sourceArtifactHash: 'a'.repeat(64) });
    const current = await inventory(); assert.match(current.result.stdout, /"unresolved": \[/);
    const args = ['--manifest-hash', current.hash, '--expected-active-catalog-id', 'none', '--backup', join(folder, 'backup'), '--checkpoint', join(folder, 'checkpoint.json')];
    const missing = await run(args); assert.notEqual(missing.code, 0); assert.match(missing.stderr, /MATH_UNRESOLVED_REFERENCES/);
    assert.equal((await col('source_aliases').get()).size, 0);
    await col('settings').doc('main').set({ schemaVersion: 1, activeCatalogId: 'different' });
    const wrong = await run(args); assert.notEqual(wrong.code, 0); assert.match(wrong.stderr, /CATALOG_CHANGED/);
  } finally { await reset(); await rm(folder, { recursive: true, force: true }); }
});
