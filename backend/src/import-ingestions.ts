import { createHash } from 'node:crypto';
import { ImportCheckpointError } from './import-parts.js';
import type { ImportSourceOrigin } from './types.js';

export function parseSourceOrigin(value: unknown): ImportSourceOrigin | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => { throw new ImportCheckpointError(400, 'Invalid source details.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['version', 'method', 'sourceLabel', 'sourceUrl', 'capturedAt', 'sourceKind', 'textConfirmed'].includes(k))) return fail();
  if (v.version !== 1 || v.textConfirmed !== true || !['screenshot-shortcut', 'shared-image', 'image-picker', 'shared-text', 'paste', 'safari-selection'].includes(String(v.method))
    || !['post', 'comment', 'article', 'unknown'].includes(String(v.sourceKind))) return fail();
  for (const [key, max] of [['sourceLabel', 100], ['sourceUrl', 2048], ['capturedAt', 40]] as const) {
    const item = v[key];
    if (item !== undefined && (typeof item !== 'string' || item.length > max || /[\u0000-\u001f\u007f]/u.test(item))) return fail();
  }
  if (v.sourceUrl !== undefined) {
    try { const u = new URL(v.sourceUrl as string); if (u.protocol !== 'https:' || u.username || u.password) return fail(); } catch { return fail(); }
  }
  if (v.capturedAt !== undefined && !Number.isFinite(Date.parse(v.capturedAt as string))) return fail();
  return v as unknown as ImportSourceOrigin;
}

export function ingestionKey(language: string, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new ImportCheckpointError(400, 'Invalid ingestion ID.');
  return createHash('sha256').update(`${language}\0${id.toLowerCase()}`).digest('hex');
}

export function ingestionDigest(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
