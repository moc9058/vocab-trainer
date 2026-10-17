import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitImportSource, appendImportPart, subdivideImportPart } from './import-parts.js';
import { normalizeAnalysis } from './import-analysis.js';
import type { ImportSession } from './types.js';

const source = '该公司该采取行动了。';
function session(): ImportSession {
  return { id: 'article', language: 'chinese', title: 'Article', text: source.repeat(80), paragraphs: [], items: [], groupBNames: ['Read'], wordGroupId: 'a', grammarGroupId: 'g', focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '', analysisProgress: { version: 1, chunks: splitImportSource(source.repeat(80)), nextChunk: 0 } };
}
const analysis = normalizeAnalysis(JSON.stringify({ paragraphs: [{ sentences: [{ text: source, explanationLanguage: 'ja', words: [
  { term: '该', surface: '该', occurrence: 0, transliteration: 'gāi', meaning: 'その' },
  { term: '该', surface: '该', occurrence: 1, transliteration: 'gāi', meaning: 'すべき' },
], grammar: [] }] }] }), 'chinese').analysis;

test('partition preserves every source character, punctuation, paragraph, and surrogate pair', () => {
  for (const text of [source.repeat(80), '。！\n\n'+source, 'A long English sentence, with punctuation.\n'.repeat(70), '😀'.repeat(401), '文'.repeat(8000), '甲，乙；丙。'.repeat(300)]) {
    const parts = splitImportSource(text);
    assert.equal(parts.join(''), text);
    assert.ok(parts.every(part => part.length <= 300));
    assert.ok(parts.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part)));
  }
});

test('checkpoints append new globally indexed rows, preserve registrations/groups, and replay without duplication', () => {
  const first = appendImportPart(session(), 0, analysis, { 该: 'word-1' }, {});
  assert.equal(first.analysisProgress?.nextChunk, 1);
  assert.equal(first.items[0].kind === 'word' && first.items[0].existingWordId, 'word-1');
  first.items[0].status = 'registered';
  first.items[0].registrations = { A: { status: 'registered', groupIds: ['a'] } };
  const before = structuredClone(first);
  const next = appendImportPart(first, 1, analysis, {}, {});
  assert.deepEqual(next.items.slice(0, first.items.length), before.items);
  assert.deepEqual(next.groupBNames, ['Read']);
  assert.equal(next.wordGroupId, 'a');
  assert.deepEqual(next.paragraphs.flatMap(p => p.sentences).map(s => s.index), [0, 1]);
  assert.ok(next.items.some(item => item.kind === 'word' && item.occurrenceId === 's1-o1'));
  assert.deepEqual(appendImportPart(next, 1, analysis, {}, {}), next);
});

test('timeout subdivision preserves source and completed checkpoints and never repeats a subdivision', () => {
  const current = session(); current.analysisProgress!.nextChunk = 1;
  const target = current.analysisProgress!.chunks[1];
  const next = subdivideImportPart(current, 1, target);
  assert.equal(next.analysisProgress!.chunks.join(''), current.text);
  assert.equal(next.analysisProgress!.nextChunk, 1);
  assert.equal(next.analysisProgress!.chunks.length, current.analysisProgress!.chunks.length + 1);
  assert.deepEqual(subdivideImportPart(next, 1, target), next);
  assert.deepEqual(subdivideImportPart(next, 0, current.analysisProgress!.chunks[0]), next);
});

test('parts within one paragraph are joined while original paragraph breaks survive', () => {
  const first = appendImportPart(session(), 0, analysis, {}, {});
  assert.equal(appendImportPart(first, 1, analysis, {}, {}).paragraphs.length, 1);
  first.analysisProgress!.chunks[0] += '\n';
  assert.equal(appendImportPart(first, 1, analysis, {}, {}).paragraphs.length, 2);
});

test('durable compact batches retain grammar slot links and suppress fixed word candidates after rebasing', () => {
  const raw = JSON.parse(readFileSync(new URL('./test-fixtures/import-context.json', import.meta.url), 'utf8'));
  const syntax = normalizeAnalysis(JSON.stringify({ paragraphs: [{ sentences: [raw.paragraphs[0].sentences[0]] }] }), 'chinese').analysis;
  const initial = appendImportPart(session(), 0, analysis, {}, {});
  const next = appendImportPart(initial, 1, syntax, {}, {});
  const reading = next.paragraphs.flatMap(p => p.sentences)[1].readingAnalysis!;
  assert.ok(reading.constructions[0].elements.some(element => !element.fixed));
  assert.ok(reading.occurrences.every(word => word.id.startsWith('s1-')));
  assert.ok(reading.constructions[0].elements.every(element => element.occurrenceIds.every(id => id.startsWith('s1-'))));
  const added = next.items.filter(item => item.sentenceIndex === 1);
  assert.deepEqual(added.filter(item => item.kind === 'word').map(item => item.kind === 'word' ? item.term : ''), ['该', '公司', '采取', '行动']);
  assert.ok(added.some(item => item.kind === 'grammar' && item.constructionId === 's1-c0' && item.fixedElements?.length === 2));
});
