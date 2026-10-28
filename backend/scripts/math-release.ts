/** Deploy-time JSON validation, immutable staging and explicit CAS activation. */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { contentHash, invariant } from '../src/math-schema.js';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, project: { type: 'string' }, database: { type: 'string' },
  production: { type: 'boolean' }, report: { type: 'string' },
}});
const command = positionals[0];
invariant(['validate', 'stage', 'activate', 'rollback'].includes(command), 'MATH_RELEASE_COMMAND_REQUIRED');
const root = resolve(values.root ?? fileURLToPath(new URL('../../textbook/', import.meta.url)));
const reportPath = resolve(values.report ?? fileURLToPath(new URL('../data/math-release.json', import.meta.url)));
if (command === 'validate') {
  const { buildCatalog } = await import('../src/math-content.js');
  const result = await buildCatalog(root);
  invariant(result.catalog.parserVersion.startsWith('math-json'), 'MATH_JSON_CATALOG_REQUIRED');
  console.log(JSON.stringify({ catalogId: result.catalog.id, units: result.catalog.units.length, objectives: result.catalog.objectives.length, warnings: result.warnings }));
} else {
  invariant(values.project && values.database, 'MATH_EXPLICIT_TARGET_REQUIRED');
  invariant(values.production ? !process.env.FIRESTORE_EMULATOR_HOST : Boolean(process.env.FIRESTORE_EMULATOR_HOST) && values.project.startsWith('demo-'), 'MATH_TARGET_MISMATCH');
  process.env.FIRESTORE_PROJECT = values.project;
  process.env.FIRESTORE_DATABASE_ID = values.database;
  const { activeCatalogId, publishCatalog, activateCatalog, rollbackCatalog, collection, requiredDoc, readChunks } = await import('../src/math-store.js');
  if (command === 'stage') {
    const { buildCatalog } = await import('../src/math-content.js');
    const result = await buildCatalog(root);
    invariant(result.catalog.parserVersion.startsWith('math-json'), 'MATH_JSON_CATALOG_REQUIRED');
    let previousCatalogId = await activeCatalogId();
    // Repeating an already activated release must retain its actual rollback target.
    if (previousCatalogId === result.catalog.id) {
      try {
        const previousReport = JSON.parse(await readFile(reportPath, 'utf8'));
        invariant(previousReport.project === values.project && previousReport.database === values.database, 'MATH_RELEASE_REPORT_TARGET_MISMATCH');
        if (previousReport.catalogId === result.catalog.id) previousCatalogId = previousReport.previousCatalogId;
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (previousCatalogId === result.catalog.id) previousCatalogId = null;
    }
    await publishCatalog(result.catalog, result.sources, result.provenances, await activeCatalogId(), true);
    const ref = collection('catalogs').doc(result.catalog.id);
    const meta = await requiredDoc<any>(ref);
    invariant(contentHash(await readChunks(ref, 'manifest_chunks', meta.manifest)) === contentHash(result.catalog), 'MATH_READBACK_FAILED');
    const report = { schemaVersion: 2, project: values.project, database: values.database,
      previousCatalogId, catalogId: result.catalog.id, stagedAt: Date.now(), state: 'staged' };
    await mkdir(dirname(reportPath), { recursive: true });
    const temporaryReport = `${reportPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryReport, JSON.stringify(report, null, 2), { mode: 0o600 });
    await rename(temporaryReport, reportPath);
    console.log(JSON.stringify(report));
  } else {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    invariant(report.project === values.project && report.database === values.database, 'MATH_RELEASE_REPORT_TARGET_MISMATCH');
    if (command === 'activate') await activateCatalog(report.catalogId, report.previousCatalogId);
    else {
      invariant(report.previousCatalogId, 'MATH_NO_PREVIOUS_CATALOG');
      if (await activeCatalogId() !== report.previousCatalogId) await rollbackCatalog(report.previousCatalogId, report.catalogId);
    }
    report.state = command === 'activate' ? 'activated' : 'rolled-back';
    report.updatedAt = Date.now();
    const temporaryReport = `${reportPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryReport, JSON.stringify(report, null, 2), { mode: 0o600 });
    await rename(temporaryReport, reportPath);
    console.log(JSON.stringify(report));
  }
}
