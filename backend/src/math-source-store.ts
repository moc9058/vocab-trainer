/** Immutable JSON source artifacts and compatibility aliases for historic catalogs. */
import { collection, readDoc, requiredDoc, writeChunks, readChunks, bounded } from './math-store.js';
import { contentHash, invariant } from './math-schema.js';

export interface JsonSource {
  format: 'textbook-json';
  schemaVersion: 2;
  contentHash: string;
  chunks: { count: number; hash: string };
}
export interface SourceAlias {
  jsonHash: string;
  originalSha256: string;
  migrationVersion: 2;
}
export async function saveJsonSource(value: unknown): Promise<string> {
  invariant(typeof value === 'object' && value !== null, 'MATH_JSON_SOURCE_REQUIRED');
  const hash = contentHash(value), ref = collection('source_revisions').doc(hash);
  const current = await readDoc<JsonSource>(ref);
  if (current) {
    invariant(current.format === 'textbook-json' && current.contentHash === hash, 'MATH_IMMUTABLE_CONFLICT', 409);
    await readChunks(ref, 'chunks', current.chunks);
    return hash;
  }
  const chunks = await writeChunks(ref, 'chunks', value);
  invariant(contentHash(await readChunks(ref, 'chunks', chunks)) === hash, 'MATH_READBACK_FAILED', 503);
  await ref.create(bounded({ format: 'textbook-json', schemaVersion: 2, contentHash: hash, chunks }));
  return hash;
}
export async function loadSourceArtifact(hash: string): Promise<unknown> {
  invariant(/^[a-f0-9]{64}$/.test(hash), 'MATH_INVALID_SOURCE_HASH');
  const alias = await readDoc<SourceAlias>(collection('source_aliases').doc(hash));
  const id = alias?.jsonHash ?? hash;
  const source = await requiredDoc<any>(collection('source_revisions').doc(id));
  if (source.format === 'textbook-json') {
    const value = await readChunks(collection('source_revisions').doc(id), 'chunks', source.chunks);
    invariant(contentHash(value) === source.contentHash && id === source.contentHash, 'MATH_SOURCE_CORRUPT', 503);
    return value;
  }
  // Read-only until the explicit maintenance migration removes raw legacy sources.
  invariant(!alias && typeof source.markdown === 'string', 'MATH_SOURCE_UNSUPPORTED', 503);
  return { schemaVersion: 2, format: 'legacy-source', originalHash: hash,
    content: [{ type: 'block', id: 'legacy-body', format: 'markdown', text: source.markdown }] };
}
