import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMeaningUnits, validateMeaningUnits } from './import-meaning-units.js';
import { detailedImportSchema, requiresMeaningUnits } from './import-explanation-config.js';
import { compactImportSchema } from './import-analysis-config.js';
import { ingestionDigest, ingestionKey, parseSourceOrigin } from './import-ingestions.js';
import { readFileSync } from 'node:fs';

const unit = (text: string) => ({ text, meaning: '意味', role: '結論' });
const value = (...texts: string[]) => ({ units: texts.map(unit), flow: 'つながり' });
test('meaning units preserve repeated text, whitespace and UTF-16 offsets without a first-match guess', () => {
  const source = '😀虽然如此，虽然如此。\n';
  const result = normalizeMeaningUnits(source, value('😀虽然如此，', '虽然如此。\n'));
  assert.equal(result.units[0].range.end, 7);
  assert.equal(result.units[1].range.start, 7);
  assert.equal(result.units.map(u => u.text).join(''), source);
  assert.ok(validateMeaningUnits(source, result));
  assert.ok(!validateMeaningUnits(source, { ...result, units: [{ ...result.units[0], range: { start: 0, end: 1 } }, result.units[1]] }));
});
test('meaning units reject omission, duplication, grapheme splits, empty values and size overflow', () => {
  for (const [source, raw] of [
    ['一二', value('一')], ['一二', value('一', '一')], ['e\u0301好', value('e', '\u0301好')],
    ['👩‍👩‍👧好', value('👩', '‍👩‍👧好')], ['a', null], ['a', { units: [], flow: 'x' }],
    ['a', { units: [unit('a')], flow: '' }], ['a', { units: [{ ...unit('a'), meaning: 'x'.repeat(501) }], flow: 'x' }],
    ['a'.repeat(25), value(...Array(25).fill('a'))],
  ] as [string, unknown][]) assert.throws(() => normalizeMeaningUnits(source, raw));
});
test('runtime explanation schema is shared, strict and isolated from compact initial analysis', () => {
  const schema = JSON.parse(readFileSync(new URL('../DB/import/analyze_schema.json', import.meta.url), 'utf8'));
  const original = structuredClone(schema), detail = detailedImportSchema(schema);
  assert.deepEqual(schema, original);
  assert.equal(requiresMeaningUnits(detail), true);
  assert.equal(requiresMeaningUnits(compactImportSchema(detail)), false);
  assert.equal(requiresMeaningUnits(original), false, 'frozen old jobs remain legacy');
});
test('source metadata and ingestion identities reject unsafe values without fetching URLs', () => {
  const origin = { version: 1, method: 'shared-image', sourceKind: 'comment', textConfirmed: true, sourceUrl: 'https://example.org/post' };
  assert.deepEqual(parseSourceOrigin(origin), origin);
  for (const method of ['shared-image', 'screenshot-shortcut', 'image-picker']) {
    const automatic = { ...origin, method, textConfirmed: false, analysisMode: 'automatic-ocr' };
    assert.deepEqual(parseSourceOrigin(automatic), automatic);
    for (const patch of [{ textConfirmed: true }, { method: 'shared-text' }, { method: 'paste' }, { analysisMode: 'unknown' }]) {
      assert.throws(() => parseSourceOrigin({ ...automatic, ...patch }));
    }
  }
  assert.deepEqual(parseSourceOrigin({ ...origin, method: 'safari-selection' }), { ...origin, method: 'safari-selection' });
  for (const patch of [{ sourceUrl: 'file:///secret' }, { sourceUrl: 'https://name:pass@example.org' }, { textConfirmed: false }, { sourceLabel: 'x\nheader' }, { capturedAt: 'invalid' }, { image: 'base64' }]) assert.throws(() => parseSourceOrigin({ ...origin, ...patch }));
  assert.equal(ingestionDigest({ b: 1, a: [1, 2] }), ingestionDigest({ a: [1, 2], b: 1 }));
  assert.notEqual(ingestionDigest({ text: '甲' }), ingestionDigest({ text: '乙' }));
  assert.throws(() => ingestionKey('chinese', '../bad'));
});
