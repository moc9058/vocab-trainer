import { expect, it } from 'vitest';
import { importWordIssues, wordRepairRange } from './importWordRepair';
import { materializeGaps } from './importSession';
import { readingOccurrences } from './importReadingAnalysis';
import type { ImportItem, ImportSentence, ImportWordItem } from '../types';

const text = '大跌，最大跌幅，齐跌。';
const sentence: ImportSentence = { index: 0, text };
const word = (id: string, term: string, start: number, reading?: string): ImportWordItem => ({
  id, kind: 'word', sentenceIndex: 0, term, order: start, origin: 'llm', status: 'pending',
  range: { start, end: start + term.length }, sourceTerm: term, surface: term, transliteration: reading,
});

it('detects overlapping ordinals and missing pinyin while preserving healthy and non-Han words', () => {
  const rows: ImportItem[] = [word('a', '大跌', 0, 'dàdiē'), word('b', '跌幅', 5, 'diēfú'), word('bad', '跌', 5, 'diē'), word('gap', '跌', 9)];
  expect(importWordIssues(sentence, rows).map(i => [i.word.id, i.position])).toEqual([['b', true], ['bad', true], ['gap', false]]);
  expect(importWordIssues({ index: 0, text: 'ARM为' }, [word('latin', 'ARM', 0), word('han', '为', 3, 'wèi')])).toEqual([]);
  expect(importWordIssues(sentence, [word('echo', '跌', 9, '跌')])).toHaveLength(1);
  expect(importWordIssues(sentence, [{ ...word('skip', '跌', 9), status: 'skipped' }])).toEqual([]);
});

it('materializes exact gap positions even when the same spelling already has an earlier candidate', () => {
  const rows = [word('a', '大跌', 0, 'dàdiē'), word('b', '最', 3, 'zuì'), word('c', '跌幅', 5, 'diēfú'), word('d', '齐', 8, 'qí'), word('bad', '跌', 5, 'diē')];
  const items = materializeGaps(rows, 0, text, 'chinese');
  const gaps = items.filter((i): i is ImportWordItem => i.kind === 'word' && i.origin === 'gap');
  expect(gaps.map(w => [w.term, w.range])).toEqual([['大', { start: 4, end: 5 }], ['跌', { start: 9, end: 10 }]]);
  expect(materializeGaps(items, 0, text, 'chinese')).toEqual(items);
});

it('legacy gaps claim their stored position instead of stealing pinyin from every matching substring', () => {
  const gap: ImportWordItem = { id: 'legacy', kind: 'word', sentenceIndex: 0, term: '跌', order: 9, origin: 'gap', status: 'registered' };
  expect(wordRepairRange(text, gap)).toEqual({ start: 9, end: 10 });
  const occurrences = readingOccurrences(sentence, [word('a', '大跌', 0, 'dàdiē'), word('b', '跌幅', 5, 'diēfú'), gap]);
  expect(occurrences.filter(o => o.surface === '跌').map(o => o.range.start)).toEqual([9]);
  expect(occurrences.find(o => o.surface === '大跌')?.transliteration).toBe('dàdiē');
  expect(wordRepairRange(text, { ...gap, order: -1 })).toBeUndefined();
});
