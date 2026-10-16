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

async function checkpointSetup(page: Page, scenario: 'timeout' | 'lost' | 'cancel') {
  let stored: any = null;
  const calls: number[] = [];
  let secondFails = true;
  let release: (() => void) | undefined;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith('/check-terms')) { await route.fulfill({ json: { existing: {} } }); return; }
    if (path === '/api/import/chinese/sessions') {
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        expect(body.analyzeInParts).toBe(true);
        stored = { ...body, id: 'parts', createdAt: '', updatedAt: '', paragraphs: [], items: [], analysisProgress: { version: 1, chunks: ['你好。', '第二段。'], nextChunk: 0 } };
        await route.fulfill({ status: 201, json: stored }); return;
      }
      await route.fulfill({ json: { sessions: stored ? [{ ...stored, totalCount: stored.items.length, registeredCount: 0 }] : [], pool: { wordIds: [], grammarIds: [] } } }); return;
    }
    if (path.endsWith('/analyze-next')) {
      const index = route.request().postDataJSON().chunkIndex;
      calls.push(index);
      if (index === 1 && secondFails) {
        secondFails = false;
        if (scenario === 'timeout') { await route.fulfill({ status: 504, json: { code: 'IMPORT_TIMEOUT', message: 'Analysis timed out.' } }); return; }
        if (scenario === 'cancel') {
          await new Promise<void>(resolve => { release = resolve; });
          await route.abort().catch(() => {}); return;
        }
      }
      if (index === stored.analysisProgress.nextChunk) {
        stored.paragraphs.push({ sentences: [{ index, text: stored.analysisProgress.chunks[index] }] });
        stored.items.push({ id: `row${index}`, kind: 'word', sentenceIndex: index, order: 0, term: index === 0 ? '你好' : '第二段', transliteration: index === 0 ? 'nǐ hǎo' : '', meaning: 'test', origin: 'llm', status: 'pending' });
        stored.analysisProgress.nextChunk++;
      }
      if (scenario === 'lost' && index === 1) { await route.abort('connectionreset'); return; }
      await route.fulfill({ json: stored }); return;
    }
    if (path === '/api/import/chinese/sessions/parts') {
      if (method === 'PUT') stored = { ...stored, ...route.request().postDataJSON() };
      await route.fulfill({ json: stored }); return;
    }
    await route.fulfill({ json: [] });
  });
  await page.goto('/tests/browser/harness.html?mode=import-view');
  await page.getByRole('button', { name: /Import a new source/ }).click();
  await page.locator('textarea').fill('你好。第二段。');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  return { calls, stored: () => stored, release: () => release?.() };
}

test('initial analysis saves each part and resumes only the failed part after a reload', async ({ page }) => {
  const state = await checkpointSetup(page, 'timeout');
  await expect(page.getByRole('alert')).toContainText('timed out');
  await expect(page.getByText('Not yet analyzed', { exact: true })).toBeVisible();
  expect(state.stored().analysisProgress.nextChunk).toBe(1);
  const first = structuredClone(state.stored().items[0]);
  await page.reload();
  await page.getByRole('button', { name: /你好。第二段。/ }).click();
  await page.getByRole('button', { name: 'Continue analysis' }).click();
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue analysis' })).toHaveCount(0);
  expect(state.calls).toEqual([0, 1, 1]);
  expect(state.stored().items[0]).toEqual(first);
  expect(state.stored().analysisProgress.nextChunk).toBe(2);
});

test('a lost final response recovers the saved checkpoint without a duplicate analysis or misleading error', async ({ page }) => {
  const state = await checkpointSetup(page, 'lost');
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.calls).toEqual([0, 1]);
  expect(state.stored().items).toHaveLength(2);
});

test('cancel preserves completed parts and later continues from the checkpoint', async ({ page }) => {
  const state = await checkpointSetup(page, 'cancel');
  await expect.poll(() => state.calls.length).toBe(2);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  state.release();
  await page.getByRole('button', { name: /你好。第二段。/ }).click();
  await expect(page.getByRole('button', { name: '你好', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue analysis' }).click();
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible();
  expect(state.calls).toEqual([0, 1, 1]);
});

test('continuing analysis drains pending edits before appending the next saved part', async ({ page }) => {
  const state = await checkpointSetup(page, 'timeout');
  await expect(page.getByRole('alert')).toContainText('timed out');
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  await page.getByPlaceholder('Meaning (fill in after a split or merge)').fill('edited contextual meaning');
  await page.getByRole('button', { name: 'Continue analysis', exact: true }).click();
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible();
  expect(state.stored().items[0].meaning).toBe('edited contextual meaning');
  expect(state.stored().analysisCheckpoint).toBe(1);
  expect(state.calls).toEqual([0, 1, 1]);
});

test('a completed compact import explains a selected sentence once and reuses the saved explanation', async ({ page }) => {
  const state = await checkpointSetup(page, 'timeout');
  await expect(page.getByRole('alert')).toContainText('timed out');
  await page.getByRole('button', { name: 'Continue analysis' }).click();
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible();
  let generations = 0;
  await page.route('**/sentences/0/explanation', async route => {
    generations++;
    await route.fulfill({ json: { sentenceIndex: 0, readingAnalysis: { version: 1, sourceText: '你好。', explanationLanguage: 'ja', overview: '挨拶の文です。', occurrences: [], constructions: [], ambiguityNotes: [] } } });
  });
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('挨拶の文です。');
  await expect.poll(() => state.stored().paragraphs[0].sentences[0].readingAnalysis?.version).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('挨拶の文です。');
  expect(generations).toBe(1);
});
