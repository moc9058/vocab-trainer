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

function linkedFixture(): ImportSession {
  const text = '与他再无任何关系，任何。';
  const occurrences = [
    ['与', 0, 1], ['他', 1, 2], ['再无', 2, 4], ['任何', 4, 6], ['关系', 6, 8], ['任何', 9, 11],
  ].map(([surface, start, end], n) => ({ id: `o${n}`, surface: String(surface), range: { start: Number(start), end: Number(end) }, lemma: String(surface), contextualMeaning: 'old', transliteration: 'old', explanationLanguage: 'ja', partOfSpeech: '', role: '', reasoning: '', contrast: '', senseKey: '', constructionIds: ['c'] }));
  const elements = occurrences.slice(0, 5).map((o, n) => ({ occurrenceIds: [o.id], fixed: [0, 2, 3].includes(n), role: '', explanation: 'old explanation' }));
  const s = fixture();
  s.text = text; s.paragraphs[0].sentences[0] = { index: 0, text, readingAnalysis: { version: 1, sourceText: text, explanationLanguage: 'ja', overview: 'whole meaning', occurrences, constructions: [{ id: 'c', statement: '与 + n + 再无 + 任何 + n', elements, ranges: occurrences.slice(0, 5).map(o => o.range), meaning: 'whole construction', roleInSentence: '' }], ambiguityNotes: [] } };
  s.items[0] = { ...s.items[0], kind: 'grammar', statement: '与 + n + 再无 + 任何 + n', description: 'old', constructionId: 'c', fixedElements: [0, 2, 3].map(n => ({ range: occurrences[n].range, surface: occurrences[n].surface, meaning: 'old' })) };
  return s;
}
const linkedInput = { itemId: 'g', start: 4, end: 6, term: '任何', meaning: 'いかなる', transliteration: 'rèn hé', explanationLanguage: 'ja', mode: 'replace' as const };
test('conversion synchronizes the linked pattern and selected occurrence, preserving other occurrences and undo snapshots', () => {
  const s = linkedFixture(), original = structuredClone(s);
  const next = convertCandidate(s, 'linked', linkedInput, 0);
  const reading = next.paragraphs[0].sentences[0].readingAnalysis!;
  assert.equal(reading.constructions[0].statement, '与 + n + 再无 + x + n');
  assert.equal(reading.constructions[0].elements[3].fixed, false);
  assert.equal(reading.constructions[0].elements[3].explanation, 'いかなる');
  assert.equal(reading.occurrences[3].contextualMeaning, 'いかなる');
  assert.equal(reading.occurrences[3].transliteration, 'rèn hé');
  assert.deepEqual(reading.occurrences[5], original.paragraphs[0].sentences[0].readingAnalysis!.occurrences[5]);
  assert.deepEqual(s, original);
  const r = newRevision(s, 'linked', request); r.state = 'applied'; r.appliedRevision = 1;
  r.before = { items: s.items, sentences: s.paragraphs[0].sentences };
  r.after = { items: next.items, sentences: next.paragraphs[0].sentences };
  assert.deepEqual(undoRevision(next, r).paragraphs, original.paragraphs);
});
test('already converted words can be enriched without duplicate candidates or losing registrations; legacy readings repair on save', () => {
  const s = linkedFixture(), next = convertCandidate(s, 'linked', linkedInput, 0);
  const word = next.items.at(-1)!; assert.equal(word.kind, 'word');
  word.status = 'registered'; word.registrations = { B: { status: 'registered', groupIds: ['b'] } };
  next.paragraphs = s.paragraphs; // an article converted by the old implementation
  const updated = convertCandidate(next, 'enrich', { ...linkedInput, itemId: word.id, meaning: 'どんな〜も' }, 1);
  assert.equal(updated.items.length, next.items.length);
  assert.deepEqual(updated.items.at(-1)!.registrations, word.registrations);
  assert.equal(updated.paragraphs[0].sentences[0].readingAnalysis!.constructions[0].statement, '与 + n + 再无 + x + n');
  assert.equal(updated.paragraphs[0].sentences[0].readingAnalysis!.occurrences[3].contextualMeaning, 'どんな〜も');
  assert.throws(() => convertCandidate(next, 'bad', { ...linkedInput, itemId: word.id, term: '別語' }, 1), /Keep the converted/);
});
test('related visible grammar candidates receive new identities while historical registrations stay intact', () => {
  const s = linkedFixture(); s.items.push({ ...s.items[0], id: 'related' });
  const next = convertCandidate(s, 'linked', linkedInput, 0);
  const old = next.items.find(i => i.id === 'related')!;
  assert.equal(old.hiddenByRevision, 'linked'); assert.deepEqual(old.registrations, s.items[0].registrations);
  const replacement = next.items.find(i => i.id === 'linked-linked-related')!;
  assert.equal(replacement.kind === 'grammar' && replacement.statement, '与 + n + 再无 + x + n');
  assert.equal(replacement.registrations, undefined);
  assert.equal(replacement.status, 'pending');
});
test('compact conversions change only the selected repeated fixed token; add mode keeps the grammar candidate', () => {
  const s = linkedFixture(); delete s.paragraphs[0].sentences[0].readingAnalysis;
  s.items[0] = { ...s.items[0], kind: 'grammar', statement: '任何 + 任何', description: '', fixedElements: [{ surface: '任何', range: { start: 4, end: 6 }, meaning: '' }, { surface: '任何', range: { start: 9, end: 11 }, meaning: '' }] };
  s.items.push({ ...s.items[0], id: 'related' });
  const next = convertCandidate(s, 'compact', linkedInput, 0);
  assert.equal(next.items.at(-1)!.kind === 'grammar' && next.items.at(-1)!.statement, 'x + 任何');
  const added = convertCandidate(linkedFixture(), 'add', { ...linkedInput, mode: 'add' }, 0);
  assert.equal(added.items[0].hiddenByRevision, undefined);
  assert.equal(added.paragraphs[0].sentences[0].readingAnalysis!.constructions[0].statement, '与 + n + 再无 + 任何 + n');
});
