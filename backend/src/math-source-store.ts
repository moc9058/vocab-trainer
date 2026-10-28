/** Immutable JSON source artifacts and compatibility aliases for historic catalogs. */
import { createHash } from 'node:crypto';
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
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function saveJsonSource(value: unknown): Promise<string> {
  invariant(typeof value === 'object' && value !== null, 'MATH_JSON_SOURCE_REQUIRED');
  const hash = contentHash(value), ref = collection('source_revisions').doc(hash);
  const verify = async (current: JsonSource) => {
    invariant(current.format === 'textbook-json' && current.schemaVersion === 2 && current.contentHash === hash, 'MATH_IMMUTABLE_CONFLICT', 409);
    invariant(contentHash(await readChunks(ref, 'chunks', current.chunks)) === hash, 'MATH_SOURCE_CORRUPT', 503);
  };
  const current = await readDoc<JsonSource>(ref);
  if (current) { await verify(current); return hash; }
  const chunks = await writeChunks(ref, 'chunks', value);
  invariant(contentHash(await readChunks(ref, 'chunks', chunks)) === hash, 'MATH_READBACK_FAILED', 503);
  try { await ref.create(bounded({ format: 'textbook-json', schemaVersion: 2, contentHash: hash, chunks })); }
  catch (error: any) {
    // Concurrent staging of the same immutable artifact is an idempotent success.
    if (error.code !== 6) throw error;
    await verify(await requiredDoc<JsonSource>(ref));
  }
  return hash;
}
export async function loadSourceArtifact(hash: string): Promise<unknown> {
  invariant(isHash(hash), 'MATH_INVALID_SOURCE_HASH');
  const alias = await readDoc<SourceAlias>(collection('source_aliases').doc(hash));
  invariant(!alias || (alias.migrationVersion === 2 && isHash(alias.jsonHash) && isHash(alias.originalSha256) && alias.jsonHash !== hash), 'MATH_SOURCE_ALIAS_CORRUPT', 503);
  const id = alias?.jsonHash ?? hash;
  const source = await requiredDoc<any>(collection('source_revisions').doc(id));
  if (source.format === 'textbook-json') {
    invariant(source.schemaVersion === 2, 'MATH_SOURCE_UNSUPPORTED', 503);
    const value = await readChunks<any>(collection('source_revisions').doc(id), 'chunks', source.chunks);
    invariant(contentHash(value) === source.contentHash && id === source.contentHash, 'MATH_SOURCE_CORRUPT', 503);
    if (alias) {
      const markdown = value.content?.length === 1 && value.content[0]?.type === 'block' && value.content[0]?.format === 'markdown' ? value.content[0].text : null;
      invariant(value.format === 'legacy-source' && value.originalHash === hash && typeof markdown === 'string' &&
        contentHash(markdown) === hash && createHash('sha256').update(markdown).digest('hex') === alias.originalSha256 &&
        value.source?.originalSha256 === alias.originalSha256, 'MATH_SOURCE_ALIAS_CORRUPT', 503);
    }
    return value;
  }
  // Read-only until the explicit maintenance migration removes raw legacy sources.
  invariant(!alias && typeof source.markdown === 'string', 'MATH_SOURCE_UNSUPPORTED', 503);
  invariant(contentHash(source.markdown) === hash, 'MATH_SOURCE_CORRUPT', 503);
  return { schemaVersion: 2, format: 'legacy-source', originalHash: hash,
    content: [{ type: 'block', id: 'legacy-body', format: 'markdown', text: source.markdown }] };
}
