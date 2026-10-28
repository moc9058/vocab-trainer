/** One-time, resumable source migration. Never called by deploy. */
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { contentHash, invariant } from '../src/math-schema.js';
const { values } = parseArgs({ options: {
  project: { type: 'string' }, database: { type: 'string' }, production: { type: 'boolean' },
  'dry-run': { type: 'boolean' }, 'manifest-hash': { type: 'string' },
  'expected-active-catalog-id': { type: 'string' }, backup: { type: 'string' },
  checkpoint: { type: 'string' }, resume: { type: 'boolean' },
  'delete-legacy': { type: 'boolean' }, 'compatible-backend-url': { type: 'string' },
}});
invariant(values.project && values.database, 'MATH_EXPLICIT_TARGET_REQUIRED');
invariant(values.production ? !process.env.FIRESTORE_EMULATOR_HOST : Boolean(process.env.FIRESTORE_EMULATOR_HOST) && values.project.startsWith('demo-'), 'MATH_TARGET_MISMATCH');
process.env.FIRESTORE_PROJECT = values.project;
process.env.FIRESTORE_DATABASE_ID = values.database;
const { collection, activeCatalogId, readDoc, mathDb, requiredDoc } = await import('../src/math-store.js');
const { saveJsonSource, loadSourceArtifact } = await import('../src/math-source-store.js');
const active = await activeCatalogId();
if (!values['dry-run']) invariant(values['expected-active-catalog-id'] === (active ?? 'none'), 'CATALOG_CHANGED');
const sources = await collection('source_revisions').get();
const legacy = sources.docs.filter(d => typeof d.data().markdown === 'string');
// Immutable references must remain resolvable; inventory metadata only, never log bodies.
const references: Record<string, string[]> = {};
for (const name of ['unit_revisions', 'catalogs', 'tests', 'jobs']) {
  const docs = await collection(name).get();
  for (const doc of docs.docs) {
    const data = doc.data();
    const hashes = [data.sourceArtifactHash, data.sourceHash].filter((v): v is string => typeof v === 'string');
    for (const hash of hashes) (references[hash] ??= []).push(`${name}/${doc.id}`);
    if (name === 'catalogs') {
      for (const unit of (await doc.ref.collection('units').get()).docs) {
        const hash = unit.data().sourceArtifactHash;
        if (hash) (references[hash] ??= []).push(`catalogs/${doc.id}/units/${unit.id}`);
      }
    }
  }
}
const unresolved = [];
for (const hash of Object.keys(references)) {
  try { await loadSourceArtifact(hash); } catch { unresolved.push(hash); }
}
const inventory = { project: values.project, database: values.database, activeCatalogId: active,
  sources: legacy.map(d => ({ hash: d.id, bytes: Buffer.byteLength(d.data().markdown), references: references[d.id]?.length ?? 0, referencePaths: (references[d.id] ?? []).sort() })), unresolved };
const manifestHash = contentHash(inventory);
console.log(JSON.stringify({ ...inventory, manifestHash }, null, 2));
if (values['dry-run']) process.exit(0);
invariant(values['manifest-hash'] === manifestHash, 'MATH_INVENTORY_CHANGED');
invariant(!unresolved.length, 'MATH_UNRESOLVED_REFERENCES');
invariant(values.backup && values.checkpoint, 'MATH_BACKUP_AND_CHECKPOINT_REQUIRED');
const backupDir = resolve(values.backup), checkpointPath = resolve(values.checkpoint);
await mkdir(backupDir, { recursive: true, mode: 0o700 });
await chmod(backupDir, 0o700);
const target = `${values.project}/${values.database}`;
let checkpoint: { target: string; activeCatalogId?: string | null; migrated: Record<string, { jsonHash: string; sha256: string }> } = { target, activeCatalogId: active, migrated: {} };
if (!values.resume) {
  let existingCheckpoint = false;
  try { await readFile(checkpointPath); existingCheckpoint = true; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  invariant(!existingCheckpoint, 'MATH_CHECKPOINT_EXISTS_USE_RESUME');
}
if (values.resume) {
  checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  invariant(checkpoint.target === target, 'MATH_CHECKPOINT_TARGET_MISMATCH');
  invariant(checkpoint.activeCatalogId === active, 'CATALOG_CHANGED');
  // Resume verifies completed records too: deleted raw bodies must remain recoverable.
  for (const [hash, entry] of Object.entries(checkpoint.migrated)) {
    invariant(/^[a-f0-9]{64}$/.test(hash), 'MATH_CHECKPOINT_CORRUPT');
    const backup = JSON.parse(await readFile(join(backupDir, `${hash}.json`), 'utf8'));
    invariant(backup.hash === hash && typeof backup.markdown === 'string' && contentHash(backup.markdown) === hash &&
      createHash('sha256').update(backup.markdown).digest('hex') === entry.sha256 && backup.sha256 === entry.sha256, 'MATH_BACKUP_HASH_MISMATCH');
    const alias = await readDoc<any>(collection('source_aliases').doc(hash));
    invariant(alias?.jsonHash === entry.jsonHash && alias.originalSha256 === entry.sha256 && alias.migrationVersion === 2, 'MATH_SOURCE_ALIAS_CONFLICT');
    const loaded = await loadSourceArtifact(hash) as any;
    invariant(loaded.content?.[0]?.text === backup.markdown, 'MATH_LEGACY_READBACK_FAILED');
  }
}
if (values['delete-legacy']) {
  invariant(values['compatible-backend-url'], 'MATH_COMPATIBLE_BACKEND_REQUIRED');
  const health = await fetch(new URL('/health', values['compatible-backend-url']));
  const body = await health.json() as any;
  invariant(health.ok && body.sourceFormats?.includes('textbook-json') && body.sourceAliasVersion === 2, 'MATH_COMPATIBLE_BACKEND_REQUIRED');
  // A live worker lease, including a queued/running historic job, blocks deletion.
  const jobs = await collection('jobs').get();
  invariant(!jobs.docs.some(d => ['queued', 'running', 'retry_wait'].includes(d.data().state) || d.data().lease?.expiresAt > Date.now()), 'MATH_WORKER_LEASE_ACTIVE');
}
for (const doc of legacy) {
  const markdown: string = doc.data().markdown;
  invariant(contentHash(markdown) === doc.id, 'MATH_LEGACY_HASH_MISMATCH');
  const sha256 = createHash('sha256').update(markdown).digest('hex');
  const backupPath = join(backupDir, `${doc.id}.json`);
  const serialized = JSON.stringify({ hash: doc.id, sha256, markdown });
  try { await writeFile(backupPath, serialized, { mode: 0o600, flag: 'wx' }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  invariant(backup.hash === doc.id && backup.markdown === markdown && backup.sha256 === sha256, 'MATH_BACKUP_HASH_MISMATCH');
  const value = { schemaVersion: 2, format: 'legacy-source', originalHash: doc.id,
    source: { originalSha256: sha256 },
    content: [{ type: 'block', id: 'legacy-body', format: 'markdown', text: markdown }] };
  const jsonHash = await saveJsonSource(value);
  const aliasRef = collection('source_aliases').doc(doc.id);
  const alias = { jsonHash, originalSha256: sha256, migrationVersion: 2 };
  await mathDb.runTransaction(async tx => {
    const existing = await readDoc<any>(aliasRef, tx);
    invariant(!existing || contentHash(existing) === contentHash(alias), 'MATH_SOURCE_ALIAS_CONFLICT');
    if (!existing) tx.create(aliasRef, alias);
  });
  const loaded = await loadSourceArtifact(doc.id) as any;
  invariant(loaded.content[0].text === markdown, 'MATH_LEGACY_READBACK_FAILED');
  checkpoint.migrated[doc.id] = { jsonHash, sha256 };
  const temporaryCheckpoint = `${checkpointPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryCheckpoint, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });
  await rename(temporaryCheckpoint, checkpointPath);
  if (values['delete-legacy']) await mathDb.runTransaction(async tx => {
    const current = await requiredDoc<any>(doc.ref, tx);
    const settings = await readDoc<any>(collection('settings').doc('main'), tx);
    const currentAlias = await readDoc<any>(aliasRef, tx);
    const jobs = await tx.get(collection('jobs'));
    invariant(!jobs.docs.some(d => ['queued', 'running', 'retry_wait'].includes(d.data().state) || d.data().lease?.expiresAt > Date.now()), 'MATH_WORKER_LEASE_ACTIVE');
    invariant(currentAlias && contentHash(currentAlias) === contentHash(alias), 'MATH_SOURCE_ALIAS_CONFLICT');
    invariant((settings?.activeCatalogId ?? null) === active, 'CATALOG_CHANGED');
    invariant(current.markdown === markdown, 'MATH_LEGACY_SOURCE_CHANGED');
    tx.delete(doc.ref);
  });
}
const remaining = (await collection('source_revisions').get()).docs.filter(d => typeof d.data().markdown === 'string').length;
console.log(JSON.stringify({ migrated: Object.keys(checkpoint.migrated).length, remainingLegacy: remaining, deleted: Boolean(values['delete-legacy']) }));
