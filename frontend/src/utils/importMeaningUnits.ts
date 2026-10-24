import type { ImportMeaningUnits } from '../types';

/** The model supplies verbatim text; offsets are calculated here, never guessed. */
export function normalizeMeaningUnits(source: string, value: unknown): ImportMeaningUnits {
  const fail = (): never => { throw new Error('Invalid meaning units: preserve the complete source and grapheme boundaries.'); };
  if (!value || typeof value !== 'object') return fail();
  const data = value as Record<string, unknown>;
  const nonempty = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= limit;
  if (!Array.isArray(data.units) || !data.units.length || data.units.length > 24 || !nonempty(data.flow, 1000)) return fail();
  const boundaries = new Set([0, source.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source), s => s.index)]);
  let cursor = 0;
  const units = data.units.map(raw => {
    if (!raw || typeof raw !== 'object') return fail();
    const { text, meaning, role } = raw as Record<string, unknown>;
    if (!nonempty(text, source.length) || !nonempty(meaning, 500) || !nonempty(role, 120)) return fail();
    const start = cursor, end = start + text.length;
    if (source.slice(start, end) !== text || !boundaries.has(start) || !boundaries.has(end)) return fail();
    cursor = end;
    return { text, meaning, role, range: { start, end } };
  });
  if (cursor !== source.length) return fail();
  const result: ImportMeaningUnits = { version: 1, units, flow: data.flow };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 80_000) return fail();
  return result;
}

/** Missing means a legacy explanation; a present but invalid block must be rejected. */
export function validateMeaningUnits(source: string, value: unknown): boolean {
  try {
    const normalized = normalizeMeaningUnits(source, value);
    const saved = value as ImportMeaningUnits;
    return saved.version === 1 && saved.units.every((u, i) => u.range?.start === normalized.units[i].range.start && u.range?.end === normalized.units[i].range.end);
  } catch { return false; }
}
