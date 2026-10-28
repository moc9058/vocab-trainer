import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Firestore } from '@google-cloud/firestore';
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(localhost|127\.0\.0\.1):\d+$/.test(host)) throw new Error('Release tests require local emulator');
const project = 'demo-vocab-math-release-cli';
const db = new Firestore({ projectId: project, databaseId: '(default)' });
const execute = promisify(execFile);
test('release staging replays preserve rollback identity, activation rejects CAS conflicts, rollback replays safely', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'math-release-cli-')), report = join(folder, 'report.json');
  const wrapper = join(folder, 'release.mjs');
  const catalog = { id: '1'.repeat(64), schemaVersion: 1, parserVersion: 'math-json-test', subjects: [], nodes: [], concepts: [], units: [], objectives: [], profiles: [] };
  await writeFile(wrapper, `import { mock } from 'node:test';
    mock.module(${JSON.stringify(pathToFileURL(resolve('src/math-content.ts')).href)}, { namedExports: {
      buildCatalog: async () => (${JSON.stringify({ catalog, sources: {}, provenances: {}, warnings: [] })})
    }});
    await import(${JSON.stringify(pathToFileURL(resolve('scripts/math-release.ts')).href)});`);
  const run = async (command: string) => {
    try {
      const result = await execute(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', wrapper, command, '--project', project, '--database', '(default)', '--report', report], {
        env: { ...process.env, FIRESTORE_EMULATOR_HOST: host, FIRESTORE_PROJECT: project, FIRESTORE_DATABASE_ID: '(default)' }, timeout: 30_000 });
      return { ...result, code: 0 };
    } catch (error: any) { return { stdout: String(error.stdout), stderr: String(error.stderr), code: error.code }; }
  };
  const settings = db.collection('math_settings').doc('main');
  try {
    for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
    await db.collection('math_catalogs').doc('old').create({ complete: true, state: 'published', schemaVersion: 1 });
    await settings.set({ activeCatalogId: 'old', schemaVersion: 1 });
    let result = await run('stage'); assert.equal(result.code, 0, result.stderr);
    assert.equal((await settings.get()).data()?.activeCatalogId, 'old');
    const staged = JSON.parse(await readFile(report, 'utf8')); assert.equal(staged.previousCatalogId, 'old');
    await settings.update({ activeCatalogId: 'competing-release' });
    result = await run('activate'); assert.notEqual(result.code, 0); assert.match(result.stderr, /CATALOG_CHANGED/);
    assert.equal((await settings.get()).data()?.activeCatalogId, 'competing-release');
    await settings.update({ activeCatalogId: 'old' });
    result = await run('activate'); assert.equal(result.code, 0, result.stderr);
    assert.equal((await settings.get()).data()?.activeCatalogId, catalog.id);
    result = await run('stage'); assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(report, 'utf8')).previousCatalogId, 'old', 'same-hash replay retains rollback target');
    result = await run('activate'); assert.equal(result.code, 0, result.stderr);
    result = await run('rollback'); assert.equal(result.code, 0, result.stderr);
    assert.equal((await settings.get()).data()?.activeCatalogId, 'old');
    result = await run('rollback'); assert.equal(result.code, 0, result.stderr);
  } finally {
    for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
    await rm(folder, { recursive: true, force: true });
  }
});
