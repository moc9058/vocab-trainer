import { test, expect, type Page } from '@playwright/test';

test('full source modal renders paragraphs and persists the pinyin preference', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).fixture = {
      id: 'full-text', language: 'chinese', title: '你好', text: '你好。\n第二段。',
      paragraphs: [
        { sentences: [{ index: 0, text: '你好。' }] },
        { sentences: [{ index: 1, text: '第二段。' }] },
      ],
      items: [
        { id: 'w1', kind: 'word', sentenceIndex: 0, order: 0, term: '你', transliteration: 'nǐ', origin: 'llm', status: 'pending' },
        { id: 'w2', kind: 'word', sentenceIndex: 0, order: 1, term: '好', transliteration: 'hǎo', origin: 'llm', status: 'pending' },
      ],
      groupBNames: [], focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '',
    };
  });
  await page.goto('/tests/browser/harness.html?mode=import-full-text');
  await expect(page.locator('article p')).toHaveCount(2);
  await expect(page.locator('article p').first()).toContainText('。');
  await expect(page.getByRole('dialog')).toContainText('第二段。');
  await expect(page.locator('rt')).toHaveCount(2);
  await page.getByRole('button', { name: 'Pinyin: on' }).click();
  await expect(page.locator('rt')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('rt')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByText('closed')).toBeVisible();
});

type Scenario = 'followup' | 'lost-response' | 'conflict' | 'both';
async function setup(page: Page, scenario: Scenario) {
  let stored = false;
  let creates = 0;
  let groupFailure = scenario === 'followup';
  const attached = new Set<string>();
  let session: any = { id: 'article', language: 'chinese', title: '', text: '总统讲话。', paragraphs: [{ index: 0, sentences: [{ index: 0, text: '总统讲话。' }] }],
    wordGroupId: 'a', groupBNames: ['Article'], items: [{ id: 'row', kind: 'word', sentenceIndex: 0, order: 0, term: '总统', origin: 'llm', status: 'pending' }], status: 'in-progress', updatedAt: '', createdAt: '' };
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/import/chinese/sessions/article') {
      if (method === 'PUT') session = { ...session, ...route.request().postDataJSON() };
      await route.fulfill({ json: session }); return;
    }
    if (path === '/api/vocab/chinese/check-terms') { await route.fulfill({ json: { existing: stored ? { 总统: 'word-1' } : {} } }); return; }
    if (path === '/api/vocab/chinese/smart-add') {
      creates++; stored = true;
      if (scenario === 'lost-response') { await route.abort('connectionreset'); return; }
      if (scenario === 'conflict') { await route.fulfill({ status: 409, json: { error: 'already exists' } }); return; }
      await route.fulfill({ json: { id: 'word-1', term: '总统' } }); return;
    }
    if (path === '/api/vocab/chinese/groups') {
      await new Promise(resolve => setTimeout(resolve, 50));
      await route.fulfill({ json: [{ id: 'a', name: 'Main', category: 'A', wordIds: [] }, { id: 'b', name: 'Article', category: 'B', wordIds: [] }, { id: 'b2', name: 'Second article', category: 'B', wordIds: [] }] }); return;
    }
    if (path === '/api/grammar/chinese/groups') { await route.fulfill({ json: [] }); return; }
    const match = path.match(/\/groups\/(a|b|b2)\/words$/);
    if (match) {
      if (match[1] === 'b' && groupFailure) { groupFailure = false; await route.fulfill({ status: 503, json: { error: 'temporary attach failure' } }); return; }
      expect(route.request().postDataJSON().wordIds).toEqual(['word-1']);
      attached.add(match[1]); await route.fulfill({ json: { id: match[1], wordIds: ['word-1'] } }); return;
    }
    await route.fulfill({ status: 500, json: { error: `Unexpected API ${path}` } });
  });
  await page.goto('/tests/browser/harness.html?mode=import');
  await expect(page.getByTestId('items')).toContainText('总统');
  return { attached, creates: () => creates, persisted: () => session };
}
for (const scenario of ['followup', 'lost-response', 'conflict', 'both'] as const) {
  test(`import recovers ${scenario} without duplicate error or create`, async ({ page }) => {
    const state = await setup(page, scenario);
    await page.getByRole('button', { name: scenario === 'both' ? 'Add B and A together' : 'Add or Retry B', exact: true }).click();
    if (scenario === 'followup') {
      await expect(page.getByTestId('items')).toContainText('failed');
      await expect(page.getByTestId('items')).toContainText('word-1');
      await expect.poll(() => state.persisted().items[0].registrations?.B?.status).toBe('failed');
      await page.reload();
      await expect(page.getByTestId('items')).toContainText('word-1');
      await page.getByRole('button', { name: 'Add or Retry B', exact: true }).click();
    }
    await expect.poll(() => [...state.attached].sort()).toEqual(['a', 'b']);
    await expect(page.getByTestId('items')).toContainText('registered');
    await expect(page.getByTestId('items')).not.toContainText('already exists');
    await expect(page.getByTestId('results')).not.toContainText('already exists');
    expect(state.creates()).toBe(1);
    // Registered status must not freeze the old destination for future presses.
    await page.getByRole('button', { name: 'Change B destination' }).click();
    await page.getByRole('button', { name: 'Add or Retry B', exact: true }).click();
    await expect.poll(() => state.attached.has('b2')).toBe(true);
    expect(state.creates()).toBe(1);
  });
}
