import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRevision, convertCandidate, newRevision, proposeRevision, splitRevisionPayload, undoRevision } from './import-revisions.js';
import type { ImportAnalysisResult, ImportRevisionRequest, ImportSession } from './types.js';
const fixture = (): ImportSession => ({ id: 's', language: 'chinese', title: '', text: '他倒是答应了。第二句。', paragraphs: [{ sentences: [{ index: 0, text: '他倒是答应了。' }, { index: 1, text: '第二句。' }] }],
  items: [{ id: 'g', kind: 'grammar', statement: '倒是', description: 'old', sentenceIndex: 0, order: 0, origin: 'llm', status: 'registered', existingGrammarId: 'library-g', registrations: { B: { status: 'registered', groupIds: ['b'] } } }, { id: 'other', kind: 'grammar', statement: 'untouched', description: '', sentenceIndex: 1, order: 0, origin: 'manual', status: 'pending' }],
  groupBNames: ['B'], focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '' });
const request: ImportRevisionRequest = { kind: 'regenerate', sentenceIndices: [0], update: 'both', instruction: 'simpler', explanationLanguage: 'ja', expectedRevision: 0, idempotencyKey: 'key' };
const analysis: ImportAnalysisResult = { paragraphs: [{ sentences: [{ index: 0, text: '他倒是答应了。', readingAnalysis: { version: 1, sourceText: '他倒是答应了。', explanationLanguage: 'ja', overview: 'whole meaning', occurrences: [], constructions: [], ambiguityNotes: [] } }] }], words: [], grammar: [{ sentenceIndex: 0, statement: '倒是', description: 'new' }] };

test('proposals do not mutate content; selective apply preserves unrelated edits and registration receipts', () => {
  const s = fixture(), before = structuredClone(s), r = proposeRevision(s, newRevision(s, 'r', request), analysis);
  assert.deepEqual(s, before); assert.equal(r.changes[0].action, 'replace');
  const next = applyRevision(s, r, [r.changes[0].id], [0]);
  assert.equal(next.items.find(i => i.id === 'g')!.hiddenByRevision, 'r');
  const replacement = next.items.at(-1)!; assert.equal(replacement.kind, 'grammar');
  assert.equal(replacement.kind === 'grammar' && replacement.existingGrammarId, 'library-g'); assert.deepEqual(replacement.registrations, s.items[0].registrations);
  assert.deepEqual(next.items.find(i => i.id === 'other'), s.items[1]); assert.deepEqual(next.paragraphs[0].sentences[1], s.paragraphs[0].sentences[1]);
  assert.equal(next.paragraphs[0].sentences[0].readingAnalysis!.candidatesManaged, true);
});
test('explanation-only changes no candidates; grammar-only changes no explanations', () => {
  const s = fixture();
  const r = proposeRevision(s, newRevision(s, 'r', { ...request, update: 'explanation' }), analysis);
  assert.deepEqual(applyRevision(s, r, [], [0]).items, s.items);
  const g = proposeRevision(s, newRevision(s, 'g', { ...request, update: 'grammar' }), analysis);
  assert.deepEqual(applyRevision(s, g, [g.changes[0].id], []).paragraphs, s.paragraphs);
  assert.throws(() => applyRevision(s, g, [], [0]), /Invalid explanation/);
});
test('conversion selects a precise repeated surface and creates a new unregistered word without grammar receipts', () => {
  const s = fixture(); s.paragraphs[0].sentences[0].text = '倒是倒是。';
  const next = convertCandidate(s, 'convert', { itemId: 'g', start: 2, end: 4, term: '倒是', meaning: '文脈義', transliteration: 'dào shì', explanationLanguage: 'ja', mode: 'replace' }, 0);
  const word = next.items.at(-1)!;
  assert.equal(word.id, 'convert-word'); assert.equal(word.kind, 'word'); assert.equal(word.status, 'pending'); assert.equal(word.registrations, undefined);
  assert.ok(word.kind === 'word'); assert.deepEqual(word.range, { start: 2, end: 4 }); assert.equal(word.existingWordId, undefined);
  assert.equal(next.items[0].status, 'registered'); assert.deepEqual(next.items[0].registrations, s.items[0].registrations);
  assert.equal(next.items[0].hiddenByRevision, 'convert'); assert.equal(word.convertedFromGrammarId, 'g');
});
test('add keeps grammar visible, rejects duplicates and incomplete UTF-16 selections', () => {
  const s = fixture(), input = { itemId: 'g', start: 1, end: 3, term: '倒是', meaning: '', transliteration: '', explanationLanguage: 'ja', mode: 'add' as const };
  const next = convertCandidate(s, 'add', input, 0); assert.equal(next.items[0].hiddenByRevision, undefined);
  assert.throws(() => convertCandidate(next, 'again', input, 1), /already exists/);
  s.paragraphs[0].sentences[0].text = '𠮷倒是。';
  assert.throws(() => convertCandidate(s, 'invalid', { ...input, start: 1, end: 2 }, 0), /complete word/);
});
test('stale proposals, active analysis, invalid selections and changed source cannot apply', () => {
  const s = fixture(), r = proposeRevision(s, newRevision(s, 'r', request), analysis);
  assert.throws(() => applyRevision({ ...s, contentRevision: 1 }, r, [], [0]), /article changed/);
  assert.throws(() => newRevision({ ...s, activeRevisionId: 'other' }, 'r', request), /running/);
  assert.throws(() => applyRevision(s, r, ['unknown'], []), /Invalid candidate/);
  const changed = structuredClone(s); changed.paragraphs[0].sentences[0].text = 'changed';
  assert.throws(() => applyRevision(changed, r, [], [0]), /source changed/);
  assert.throws(() => newRevision(s, 'r', { ...request, sentenceIndices: [5] }), /consecutive/);
});
test('undo restores article candidates only and refuses later edits or registration writes', () => {
  const s = fixture(), r = proposeRevision(s, newRevision(s, 'r', request), analysis);
  const next = applyRevision(s, r, [r.changes[0].id], [0]); r.state = 'applied'; r.appliedRevision = 1;
  r.before = { items: s.items.filter(i => i.sentenceIndex === 0), sentences: [s.paragraphs[0].sentences[0]] };
  r.after = { items: next.items.filter(i => i.sentenceIndex === 0), sentences: [next.paragraphs[0].sentences[0]] };
  const restored = undoRevision(next, r); assert.deepEqual(restored.items.sort((a,b)=>a.id.localeCompare(b.id)), s.items.sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal(restored.contentRevision, 2); assert.throws(() => undoRevision({ ...next, contentRevision: 2 }, r), /article changed/);
});

test('history payload parts round-trip astral characters at every UTF-8 boundary', () => {
  const value = { text: '甲'.repeat(99990) + '𠮷'.repeat(100010) };
  const parts = splitRevisionPayload(value);
  assert.ok(parts.length > 2);
  for (const part of parts) assert.equal(Buffer.from(part).toString('utf8'), part);
  assert.deepEqual(JSON.parse(parts.join('')), value);
});
