import { expect, it } from 'vitest';
import { rebaseImportEdits } from './importEditConflict';
import type { ImportSession } from '../types';
const fixture = (): ImportSession => ({ id: 's', language: 'chinese', title: '', text: '甲。', paragraphs: [{ sentences: [{ index: 0, text: '甲。' }] }], items: [{ id: 'w', kind: 'word', sentenceIndex: 0, order: 0, term: '甲', meaning: '', origin: 'llm', status: 'pending' }], groupBNames: [], focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '' });
it('reapplies pending edits on the newest version without reverting independent server changes', () => {
  const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
  local.items[0] = { ...local.items[0], meaning: 'local' } as typeof local.items[0]; remote.title = 'remote title'; remote.contentRevision = 5;
  const rebased = rebaseImportEdits(base, local, remote);
  expect(rebased.title).toBe('remote title'); expect(rebased.contentRevision).toBe(5); expect(rebased.items[0]).toMatchObject({ meaning: 'local' });
});
it('keeps both versions intact when the same candidate was changed or registered remotely', () => {
  const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
  Object.assign(local.items[0], { meaning: 'local' }); Object.assign(remote.items[0], { meaning: 'remote' });
  expect(() => rebaseImportEdits(base, local, remote)).toThrow(/Both windows/);
  Object.assign(remote.items[0], { meaning: '', status: 'registered' });
  expect(() => rebaseImportEdits(base, local, remote)).toThrow(/registered/);
  expect(local.items[0]).toMatchObject({ meaning: 'local' });
});
