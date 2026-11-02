import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolInput, requestHash, inputJsonSchema, toolSchemas } from './integrations/contracts.js';
const operationId = 'f6c2e6bc-3189-42e1-93e9-93aefda6c915';
const base = { operationId, word: { term: '后悔' } };
test('strict registration rejects retired/server fields rather than stripping them', () => {
  assert.equal(parseToolInput('create_word', base).word.term, '后悔');
  for (const field of ['id', 'language', 'partOfSpeech', 'flag', 'exampleIds']) {
    assert.throws(() => parseToolInput('create_word', { ...base, word: { ...base.word, [field]: 'bad' } }));
  }
  assert.throws(() => parseToolInput('create_word', { ...base, word: { term: '   ' } }));
  assert.throws(() => parseToolInput('create_word', { ...base, word: { term: '后悔', notes: '字'.repeat(23000) } }));
});
test('group cardinality, language anchors and deliberate grammar duplication', () => {
  assert.throws(() => parseToolInput('create_word', { ...base, targets: { groupAIds: ['a', 'b'] } }));
  assert.throws(() => parseToolInput('create_word', { ...base, targets: { groupAIds: ['a'], groupBIds: ['a'] } }));
  const grammar = { statement: '把+O+V', descriptions: [{ partOfSpeech: '', text: { ko: '  사용자 설명  ' } }] };
  assert.equal(parseToolInput('create_grammar', { operationId, grammar }).grammar.descriptions[0].text.ko, '  사용자 설명  ');
  assert.throws(() => parseToolInput('create_grammar', { operationId, grammar, allowDuplicateStatement: true }));
  assert.throws(() => parseToolInput('create_grammar', { operationId, grammar: { ...grammar, descriptions: [{ partOfSpeech: '', text: { en: 'only English' } }] } }));
});
test('patches require versions and reject contradictory ownership/translation edits', () => {
  const update = { operationId, itemId: 'zh-001', expectedVersion: 'v1' };
  assert.throws(() => parseToolInput('update_word', { ...update, patch: {} }));
  assert.throws(() => parseToolInput('update_word', { ...update, patch: { exampleChanges: { add: [], replaceOwned: [] } } }));
  assert.throws(() => parseToolInput('delete_word', { operationId, itemId: '../secret', expectedVersion: 'v1' }));
  assert.throws(() => parseToolInput('change_item_groups', { ...update, kind: 'word', groupAIds: [] }));
  const parsed = parseToolInput('update_word', { ...update, patch: { definitionTextUpdates: [{ index: 0, language: 'ko', text: '후회하다' }] } });
  assert.equal(parsed.patch.definitionTextUpdates![0].text, '후회하다');
});
test('request hashes normalize object order but distinguish action, meanings and group targets', () => {
  assert.equal(requestHash('create_word', base), requestHash('create_word', { word: { term: ' 后悔 ' }, operationId }));
  assert.notEqual(requestHash('create_word', base), requestHash('create_word', { ...base, targets: { groupAIds: ['a'] } }));
});
test('all published tool inputs export JSON schemas', () => {
  for (const name of Object.keys(toolSchemas) as (keyof typeof toolSchemas)[]) assert.equal(inputJsonSchema(name).type, 'object');
});
