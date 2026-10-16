import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImportBatches, importJobError } from './import-jobs.js';

test('short sources remain one batch; complete long sentences are never cut', () => {
  const short = '这是第一句话。'.repeat(30);
  assert.equal(planImportBatches(short, 'chinese').length, 1);
  const long = '很'.repeat(1800) + '长。';
  const text = short + '\n\n' + long + '最后一句。';
  const chunks = planImportBatches(text, 'chinese');
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.some(c => c.includes(long)));
  assert.ok(chunks.length > 1);
});
test('sentence planning preserves paragraphs, closing quotes, emoji, Latin punctuation and decimals', () => {
  for (const [lang, text] of [ ['chinese', '他说：“你好！”\n\n第二句😀。'.repeat(100)], ['english', 'Dr. Smith paid 3.14 dollars. “Really?”\nYes! '.repeat(100)], ['japanese', '「そうです。」\n次です！'.repeat(100)], ['korean', '안녕하세요.\n다음 문장입니다! '.repeat(100)] ]) {
    const chunks = planImportBatches(text, lang);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every(c => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(c)));
  }
});
test('job failures distinguish retryable provider faults and permanent output/config/storage limits', () => {
  for (const status of [429, 500, 503]) assert.equal(importJobError({ status }).retryable, true);
  for (const status of [400, 401, 403, 404]) assert.equal(importJobError({ status }).retryable, false);
  assert.equal(importJobError(new Error('IMPORT_STORAGE_LIMIT')).code, 'IMPORT_STORAGE_LIMIT');
  assert.equal(importJobError(new Error('IMPORT_OUTPUT_LIMIT')).retryable, false);
  assert.equal(importJobError(new Error('IMPORT_SOURCE_MISMATCH')).retryable, false);
  assert.equal(importJobError(new Error('LLM processing exceeded its 540s time limit.')).code, 'IMPORT_TIMEOUT');
});
