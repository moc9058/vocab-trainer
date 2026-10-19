import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressReporter } from './import-progress.js';
import type { ImportAnalysisProgress } from './types.js';

const initial: ImportAnalysisProgress = { stage: 'waiting', attempt: 1, startedAt: '', updatedAt: '', receivedCharacters: 0 };
test('progress coalesces deltas, serializes writes and drains before stop without model text', async () => {
  const saved: ImportAnalysisProgress[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reporter = createProgressReporter(initial, async value => { await gate; saved.push(value); }, () => assert.fail('unexpected write failure'));
  reporter.receive(2); await Promise.resolve();
  for (let i = 0; i < 100; i++) reporter.receive(5);
  const stage = reporter.stage('validating');
  release(); await stage; await reporter.stop();
  assert.equal(saved.length, 2);
  assert.equal(saved[0].receivedCharacters, 2);
  assert.equal(saved[1].receivedCharacters, 502);
  assert.equal(saved[1].stage, 'validating');
  assert.ok(saved[1].firstReceivedAt); assert.ok(saved[1].lastReceivedAt);
  reporter.receive(100); await reporter.stop(); assert.equal(saved.length, 2);
});
test('a progress write failure does not fail generation or prevent subsequent updates', async () => {
  let errors = 0, attempts = 0;
  const reporter = createProgressReporter(initial, async () => { if (++attempts === 1) throw new Error('unavailable'); }, () => { errors++; });
  reporter.receive(1); await reporter.stage('validating'); await reporter.stage('saving'); await reporter.stop();
  assert.equal(errors, 1); assert.ok(attempts >= 2);
});
