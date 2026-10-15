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

// Test the actual review, including its persistence hook; the importer queue recovery tests above remain unchanged.
async function reviewSetup(page: Page, detailed = true) {
  const { default: analysis } = await import('../../src/utils/__fixtures__/import-context.json', { with: { type: 'json' } });
  const paragraph = structuredClone(analysis.paragraphs[0]);
  const explanation = paragraph.sentences[0].readingAnalysis;
  if (!detailed) delete (paragraph.sentences[0] as any).readingAnalysis;
  let saved: any = { id: 'article', language: 'chinese', title: 'Context', text: paragraph.sentences[0].text,
    paragraphs: [paragraph], items: detailed ? [] : [{ id: 'old', kind: 'word', sentenceIndex: 0, order: 0, term: '该', transliteration: 'gāi', meaning: 'その', origin: 'llm', status: 'pending' }],
    groupBNames: [], focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '' };
  let writes = 0, generations = 0;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/explanation')) {
      generations++;
      await route.fulfill({ json: { sentenceIndex: 0, readingAnalysis: explanation } }); return;
    }
    if (path === '/api/import/chinese/sessions/article') {
      if (route.request().method() === 'PUT') { writes++; saved = { ...saved, ...route.request().postDataJSON() }; }
      await route.fulfill({ json: saved }); return;
    }
    if (path.endsWith('/check-terms')) { await route.fulfill({ json: { existing: {} } }); return; }
    await route.fulfill({ json: [] });
  });
  await page.goto('/tests/browser/harness.html?mode=import-review');
  await expect(page.getByTestId('import-full-text-reader')).toBeVisible();
  return { writes: () => writes, generations: () => generations, saved: () => saved };
}

test('review opens full text, distinguishes repeated words, explains grammar and switches to the existing editor', async ({ page }) => {
  const state = await reviewSetup(page);
  const reader = page.getByTestId('import-full-text-reader');
  const gai = reader.getByRole('button', { name: '该', exact: true });
  await gai.nth(0).click();
  await expect(page.getByRole('dialog')).toContainText('その');
  await page.keyboard.press('Escape');
  await expect(gai.nth(0)).toBeFocused();
  await gai.nth(1).click();
  await expect(page.getByRole('dialog')).toContainText('そろそろ〜すべき');
  await page.getByRole('dialog').getByRole('button', { name: '该+v+了', exact: true }).click();
  await expect(gai.nth(1)).toHaveClass(/bg-emerald/);
  await page.keyboard.press('Escape');
  await reader.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('主語');
  expect(state.generations()).toBe(0);
  expect(state.writes()).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Open sentence editor' }).click();
  await expect(reader).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sentence mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  await expect(reader).toBeVisible();
});

test('legacy articles generate one sentence explanation, persist it, and retain all candidate and destination data', async ({ page }) => {
  const state = await reviewSetup(page, false);
  const beforeItems = structuredClone(state.saved().items);
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('no detailed sentence analysis');
  await page.getByRole('button', { name: 'Explain this sentence' }).click();
  await expect(page.getByRole('dialog')).toContainText('主語');
  await expect.poll(() => state.writes()).toBe(1);
  expect(state.generations()).toBe(1);
  expect(state.saved().items).toEqual(beforeItems);
  expect(state.saved().groupBNames).toEqual([]);
  expect(state.saved().paragraphs[0].sentences[0].readingAnalysis.version).toBe(1);
  await page.reload();
  await expect(page.getByTestId('import-full-text-reader')).toBeVisible();
  expect(state.generations()).toBe(1);
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('主語');
});

test('mobile full text fits 360px and its explanation sheet restores focus and scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const state = await reviewSetup(page);
  await page.getByRole('button', { name: '该', exact: true }).nth(1).click();
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Close full text' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '该', exact: true }).nth(1)).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  expect(state.writes()).toBe(0);
});

test('generation errors are visible and retry does not change the original article rows', async ({ page }) => {
  const state = await reviewSetup(page, false);
  let fail = true;
  await page.route('**/sentences/0/explanation', async route => {
    if (!fail) { await route.fallback(); return; }
    await route.fulfill({ status: 503, json: { message: 'temporarily unavailable' } });
  });
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await page.getByRole('button', { name: 'Explain this sentence' }).click();
  await expect(page.getByRole('alert')).toContainText('503');
  expect(state.writes()).toBe(0);
  fail = false;
  await page.getByRole('button', { name: 'Explain this sentence' }).click();
  await expect(page.getByRole('dialog')).toContainText('主語');
  await expect.poll(() => state.writes()).toBe(1);
});

test('late explanations are cancelled when leaving full text, and cannot overwrite the session', async ({ page }) => {
  const state = await reviewSetup(page, false);
  let release: (() => void) | undefined;
  let calls = 0;
  await page.route('**/sentences/0/explanation', async route => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fallback().catch(() => {});
  });
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await page.getByRole('button', { name: 'Explain this sentence' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect.poll(() => calls).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  release?.();
  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('no detailed sentence analysis');
  expect(state.writes()).toBe(0);
});

test('a failed explanation save keeps the existing warning and can be retried', async ({ page }) => {
  const state = await reviewSetup(page, false);
  let fail = true;
  await page.route('**/sessions/article', async route => {
    if (fail && route.request().method() === 'PUT') { await route.fulfill({ status: 503, json: { message: 'save unavailable' } }); return; }
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await page.getByRole('button', { name: 'Explain this sentence' }).click();
  await expect(page.getByText("Couldn't save", { exact: true })).toBeVisible();
  expect(state.writes()).toBe(0);
  await page.keyboard.press('Escape');
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => state.writes()).toBe(1);
  await expect(page.getByText("Couldn't save", { exact: true })).toHaveCount(0);
});
