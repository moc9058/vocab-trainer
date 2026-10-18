import { test, expect, type Page } from '@playwright/test';
import { buildImportItems } from '../../src/utils/importSession';

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
    paragraphs: [paragraph], items: detailed ? buildImportItems(analysis as any, {}, {}, 'chinese').filter(item => item.sentenceIndex === 0) : [{ id: 'old', kind: 'word', sentenceIndex: 0, order: 0, term: '该', transliteration: 'gāi', meaning: 'その', origin: 'llm', status: 'pending' }],
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
  for (const before of beforeItems) expect(state.saved().items.find((item: any) => item.id === before.id)).toMatchObject(before);
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

async function durableSetup(page: Page, scenario: 'reconnect' | 'lost' | 'pause' | 'running' | 'complete') {
  let stored: any = null, job: any = null, starts = 0, llmCalls = 0, broken = false;
  const saved: any[] = [];
  function part(index: number) {
    stored.paragraphs.push({ sentences: [{ index, text: stored.analysisProgress.chunks[index] }] });
    stored.items.push({ id: `row${index}`, kind: 'word', sentenceIndex: index, order: 0, term: index === 0 ? '你好' : '第二段', transliteration: index === 0 ? 'nǐ hǎo' : '', meaning: 'test', origin: 'llm', status: 'pending' });
    stored.analysisProgress.nextChunk = index + 1;
    job.nextBatch = index + 1; job.completedSentences = index + 1; job.revision++;
    stored.analysisRevision = job.revision;
  }
  function complete() {
    while (stored.analysisProgress.nextChunk < 2) part(stored.analysisProgress.nextChunk);
    job.state = 'completed'; stored.analysisState = 'completed'; job.revision++; stored.analysisRevision = job.revision;
  }
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (path.endsWith('/check-terms')) { await route.fulfill({ json: { existing: {} } }); return; }
    if (path === '/api/import/chinese/sessions') {
      if (method === 'POST') {
        const body = route.request().postDataJSON(); expect(body.analyzeAsJob).toBe(true);
        stored = { ...body, id: 'parts', createdAt: '', updatedAt: '', paragraphs: [], items: [], analysisProgress: { version: 1, chunks: ['你好。', '第二段。'], nextChunk: 0 } };
        await route.fulfill({ status: 201, json: stored }); return;
      }
      await route.fulfill({ json: { sessions: stored ? [{ ...stored, totalCount: stored.items.length, registeredCount: 0 }] : [], pool: { wordIds: [], grammarIds: [] } } }); return;
    }
    if (path.endsWith('/analysis-job') && method === 'POST') {
      starts++; llmCalls++;
      job = { id: 'parts', generation: 1, state: 'running', revision: 1, nextBatch: 0, totalBatches: 2, completedSentences: 0, pauseRequested: false, updatedAt: '' };
      stored.analysisJobRef = { version: 2, jobId: 'parts', generation: 1 }; stored.analysisState = 'running'; stored.analysisRevision = 1;
      if (scenario === 'pause') part(0);
      if (scenario === 'complete') complete();
      if (scenario === 'lost') { await route.abort('connectionreset'); return; }
      await route.fulfill({ status: 202, json: job }); return;
    }
    if (path.endsWith('/analysis-job') && method === 'GET') {
      if (scenario === 'reconnect' && !broken) { broken = true; await route.abort('connectionreset'); return; }
      await route.fulfill({ json: job }); return;
    }
    if (path.endsWith('/analysis-job/pause')) {
      job.state = 'paused'; job.pauseRequested = true; job.revision++; stored.analysisState = 'paused'; stored.analysisRevision = job.revision;
      await route.fulfill({ status: 202, json: job }); return;
    }
    if (path.endsWith('/analysis-job/resume')) {
      expect(stored.items[0].meaning).toBe('edited contextual meaning');
      llmCalls++; job.pauseRequested = false; complete();
      await route.fulfill({ status: 202, json: job }); return;
    }
    if (path === '/api/import/chinese/sessions/parts') {
      if (method === 'PUT') { saved.push(route.request().postDataJSON()); stored = { ...stored, ...route.request().postDataJSON() }; }
      await route.fulfill({ json: stored }); return;
    }
    await route.fulfill({ json: [] });
  });
  await page.goto('/tests/browser/harness.html?mode=import-view');
  await page.getByRole('button', { name: /Import a new source/ }).click();
  await page.locator('textarea').fill('你好。第二段。');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect.poll(() => starts).toBe(1);
  return { stored: () => stored, calls: () => llmCalls, starts: () => starts, complete, saved };
}

test('transport interruption reconnects to the same durable job and follows later completion', async ({ page }) => {
  const state = await durableSetup(page, 'reconnect');
  await expect(page.getByText(/Reconnecting to check analysis/)).toBeVisible();
  state.complete();
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('alert')).toHaveCount(0); expect(state.calls()).toBe(1); expect(state.starts()).toBe(1);
});

test('lost acceptance response recovers the accepted job without issuing another paid call', async ({ page }) => {
  const state = await durableSetup(page, 'lost');
  await expect(page.getByRole('button', { name: 'Pause after the current part' })).toBeVisible();
  state.complete();
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible({ timeout: 10000 });
  expect(state.starts()).toBe(1); expect(state.calls()).toBe(1);
});

test('returning to the list leaves the job running; reopening shows independently completed results', async ({ page }) => {
  const state = await durableSetup(page, 'running');
  await expect(page.getByRole('button', { name: 'Pause after the current part' })).toBeVisible();
  await page.getByRole('button', { name: 'Imports', exact: true }).click();
  state.complete();
  await page.getByRole('button', { name: /你好。第二段。/ }).click();
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible(); expect(state.calls()).toBe(1);
});

test('pause exposes saved content; resume drains edits and only processes the unfinished work', async ({ page }) => {
  const state = await durableSetup(page, 'pause');
  await page.getByRole('button', { name: 'Pause after the current part' }).click();
  await expect(page.getByRole('button', { name: 'Continue analysis' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  await page.getByPlaceholder('Meaning (fill in after a split or merge)').fill('edited contextual meaning');
  await page.getByRole('button', { name: 'Continue analysis', exact: true }).click();
  await expect(page.getByRole('button', { name: '第二段', exact: true })).toBeVisible();
  expect(state.stored().items[0].meaning).toBe('edited contextual meaning'); expect(state.saved[0].analysisRevision).toBeDefined(); expect(state.calls()).toBe(2);
});

test('a completed durable import explains a selected sentence once and saves it for reuse', async ({ page }) => {
  const state = await durableSetup(page, 'complete');
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
  await expect(page.getByRole('dialog')).toContainText('挨拶の文です。'); expect(generations).toBe(1);
});

test('an 8000-character partial source stays readable on mobile, switches modes and preserves the unprocessed tail', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const unit = '这是一段用于验证保存和显示的外部文本。';
  const text = unit.repeat(500).slice(0, 8000);
  const completed = unit.repeat(20), tail = text.slice(completed.length);
  let saved: any = { id: 'article', language: 'chinese', title: 'Large source', text, groupBNames: [],
    status: 'in-progress', createdAt: '', updatedAt: '', focusedSentenceIndex: 0,
    analysisState: 'failed', analysisRevision: 3, analysisJobRef: { version: 2, jobId: 'article', generation: 1 },
    analysisProgress: { version: 1, chunks: [completed, tail], nextChunk: 1 },
    paragraphs: [{ sentences: Array.from({ length: 20 }, (_, index) => ({ index, text: unit })) }],
    items: Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}`, kind: 'word', sentenceIndex: index, order: 0, term: unit.slice(0, -1), meaning: '保存済みの説明', origin: 'llm', status: 'pending' })) };
  let calls = 0;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/explanation') || path.endsWith('/analysis-job') || path.endsWith('/analyze-next')) calls++;
    if (path === '/api/import/chinese/sessions/article') {
      if (route.request().method() === 'PUT') saved = { ...saved, ...route.request().postDataJSON() };
      await route.fulfill({ json: saved }); return;
    }
    if (path.endsWith('/check-terms')) { await route.fulfill({ json: { existing: {} } }); return; }
    await route.fulfill({ json: [] });
  });
  const started = Date.now();
  await page.goto('/tests/browser/harness.html?mode=import-review');
  const reader = page.getByTestId('import-full-text-reader');
  await expect(reader).toBeVisible();
  await expect(reader.locator('article')).toContainText(unit);
  await expect(reader.locator('section p')).toHaveText(tail);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sentence mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  await expect(reader.locator('section p')).toHaveText(tail);
  expect(calls).toBe(0); expect(saved.text.length).toBe(8000);
  console.log(JSON.stringify({ largeSourceUiMs: Date.now() - started, sourceCharacters: 8000, viewport: 360 }));
});

test('reader shows fixed grammar boundaries, keeps variable words distinct and remembers a clean reading view', async ({ page }) => {
  await reviewSetup(page);
  const reader = page.getByTestId('import-full-text-reader');
  const words = reader.locator('article [data-reading-kind="word"]');
  const grammar = reader.locator('article [data-reading-kind="grammar"]');
  await expect(words).toHaveCount(4);
  await expect(grammar).toHaveCount(2);
  await expect(grammar.first()).toHaveText('该gāi');
  await expect(grammar.first()).toHaveClass(/border-dotted/);
  await reader.getByRole('button', { name: 'Grammar 1', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('该+v+了');
  await expect(grammar.first()).toHaveClass(/bg-emerald/);
  await page.keyboard.press('Escape');
  await expect(reader.getByRole('button', { name: 'Grammar 1', exact: true })).toBeFocused();
  await reader.getByRole('button', { name: 'Boundaries: on', exact: true }).click();
  await expect(grammar.first()).toHaveClass(/border-transparent/);
  await grammar.first().click();
  await expect(page.getByRole('dialog')).toContainText('Grammar element');
  await page.reload();
  await expect(reader.getByRole('button', { name: 'Boundaries: off', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

for (const compact of [false, true]) {
  test(`touching a grammar element links its partner in the mobile preview (${compact ? 'compact' : 'detailed'})`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const state = await reviewSetup(page);
    if (compact) {
      const { buildImportItems } = await import('../../src/utils/importSession');
      const { default: analysis } = await import('../../src/utils/__fixtures__/import-context.json', { with: { type: 'json' } });
      state.saved().items = buildImportItems(analysis as any, {}, {}, 'chinese');
      delete state.saved().paragraphs[0].sentences[0].readingAnalysis;
      await page.reload();
    }
    const reader = page.getByTestId('import-full-text-reader');
    const gai = reader.getByRole('button', { name: '该', exact: true });
    await gai.nth(1).click();
    await expect(gai.nth(1)).toHaveClass(/bg-emerald/);
    await expect(reader.locator('article').getByRole('button', { name: '了', exact: true })).toHaveClass(/bg-emerald/);
    await expect(gai.nth(0)).not.toHaveClass(/bg-emerald/);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: '该+v+了', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('import-sentence-preview').locator('[class*="bg-emerald-900"]')).toHaveCount(2);
    await page.screenshot({ path: `/tmp/vocab-linked-${compact ? 'compact' : 'detailed'}.png` });
    await page.keyboard.press('Escape');
    await expect(gai.nth(1)).not.toHaveClass(/bg-emerald/);
    expect(state.generations()).toBe(0);
    expect(state.writes()).toBe(0);
  });
}

test('overlapping constructions switch highlights while retaining the touched occurrence', async ({ page }) => {
  const state = await reviewSetup(page);
  const reading = state.saved().paragraphs[0].sentences[0].readingAnalysis;
  reading.constructions.push({ id: 'second', statement: '该+v', ranges: [{ start: 3, end: 4 }, { start: 4, end: 6 }], meaning: 'second pattern', roleInSentence: '', elements: [] });
  reading.occurrences[2].constructionIds.push('second');
  await page.reload();
  const reader = page.getByTestId('import-full-text-reader');
  await reader.getByRole('button', { name: '该', exact: true }).nth(1).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '该+v', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '该+v', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: '该+v+了', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(reader.locator('article').getByRole('button', { name: '了', exact: true })).not.toHaveClass(/bg-emerald/);
  await expect(dialog.getByTestId('import-construction-summary')).toContainText('second pattern');
  await expect(dialog.locator('header h3')).toHaveText('该');
});

for (const width of [360, 1280]) {
  test(`construction displays separate A, fixed 与 and B boundaries at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await reviewSetup(page);
    const sentence = state.saved().paragraphs[0].sentences[0];
    sentence.text = '甲公司与乙学校合作。';
    state.saved().items = [];
    sentence.translation = '';
    const reading = sentence.readingAnalysis;
    reading.sourceText = sentence.text;
    let cursor = 0;
    reading.occurrences = ['甲', '公司', '与', '乙', '学校', '合作'].map((surface, index) => {
      const start = cursor; cursor += surface.length;
      return { ...reading.occurrences[0], id: `o${index}`, surface, lemma: surface, transliteration: '', range: { start, end: cursor }, constructionIds: index < 5 ? ['c'] : [] };
    });
    reading.constructions = [{ id: 'c', statement: 'A + 与 + B', meaning: '並列', roleInSentence: '', ranges: reading.occurrences.slice(0, 5).map((word: any) => word.range),
      elements: [{ occurrenceIds: ['o0', 'o1'], fixed: false, role: '出来事を述べる節A', explanation: '' }, { occurrenceIds: ['o2'], fixed: true, role: '接続', explanation: '' }, { occurrenceIds: ['o3', 'o4'], fixed: false, role: 'B', explanation: '' }] }];
    await page.reload();
    const reader = page.getByTestId('import-full-text-reader');
    await reader.getByRole('button', { name: '与', exact: true }).click();
    const preview = page.getByTestId('import-sentence-preview');
    await expect(preview.locator('[data-construction-part="A"]')).toHaveCount(2);
    await expect(preview.locator('[data-construction-part="B"]')).toHaveCount(2);
    await expect(preview.locator('[data-part-kind="fixed"]')).toHaveCount(1);
    await expect(preview.locator('[data-part-kind="fixed"]')).toHaveClass(/border-dotted/);
    await expect(preview.locator('[data-construction-part="A"]').first()).toHaveClass(/bg-sky/);
    await expect(preview.locator('[data-construction-part="B"]').first()).toHaveClass(/bg-amber/);
    await expect(preview.locator('sup')).toHaveCount(0);
    const labeledParts = preview.getByTestId('import-labeled-part');
    await expect(labeledParts).toHaveCount(3);
    await expect(labeledParts.first().getByTestId('import-part-label')).toContainText('出来事を述べる節A');
    for (const part of await labeledParts.all()) {
      const sourceBox = await part.getByTestId('import-part-source').boundingBox();
      const labelBox = await part.getByTestId('import-part-label').boundingBox();
      expect(sourceBox).not.toBeNull(); expect(labelBox).not.toBeNull();
      expect(labelBox!.y).toBeGreaterThanOrEqual(sourceBox!.y + sourceBox!.height);
    }
    await expect(page.getByTestId('import-construction-summary')).toContainText('並列');
    await expect(page.getByRole('dialog').locator('details')).not.toHaveAttribute('open');
    await page.screenshot({ path: `/tmp/vocab-grammar-simple-${width}.png` });
    await page.getByRole('dialog').getByText('Structure and roles', { exact: true }).click();
    await expect(page.getByTestId('import-construction-parts')).toContainText('甲 公司');
    await expect(page.getByTestId('import-construction-parts')).toContainText('乙 学校');
    await expect(reader.locator('article').getByRole('button', { name: '合作', exact: true })).not.toHaveAttribute('data-construction-part');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/vocab-grammar-slots-${width}.png` });
    expect(state.generations()).toBe(0); expect(state.writes()).toBe(1);
  });
}

test('full text registers words and fixed grammar through their own A/B controls without a duplicate word path', async ({ page }) => {
  const state = await reviewSetup(page);
  const saved = state.saved();
  saved.wordGroupId = 'a'; saved.grammarGroupId = 'g'; saved.groupBNames = ['Article'];
  saved.items.find((item: any) => item.kind === 'word' && item.term === '公司').existingWordId = 'word-1';
  saved.items.find((item: any) => item.kind === 'grammar').existingGrammarId = 'grammar-1';
  const writes: string[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/items/batch')) { await route.fulfill({ json: { items: [{ id: 'grammar-1', statement: '该+v+了' }] } }); return; }
    if (path.endsWith('/check-terms')) { await route.fulfill({ json: { existing: { 公司: 'word-1' } } }); return; }
    if (path === '/api/grammar/chinese/groups') { await route.fulfill({ json: [{ id: 'gb', name: 'Article', category: 'B', grammarIds: [] }] }); return; }
    if (path.match(/\/groups\/(a|g|gb)\/(words|grammar)$/) || (route.request().method() === 'PUT' && path.includes('/groups/'))) {
      writes.push(path); await route.fulfill({ json: {} }); return;
    }
    if (path.includes('/smart-add')) throw new Error('Existing items must not be recreated');
    await route.fallback();
  });
  await page.reload();
  const reader = page.getByTestId('import-full-text-reader');
  await reader.getByRole('button', { name: '公司', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'A Add', exact: true }).click();
  await expect.poll(() => writes.some(path => path.includes('/vocab/') && path.includes('/groups/a/'))).toBe(true);
  await page.keyboard.press('Escape');
  await reader.getByRole('button', { name: '该', exact: true }).nth(1).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'A Add', exact: true })).toHaveCount(1);
  await expect(dialog.getByText('Meaning here:', { exact: false })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'A Add', exact: true }).click();
  await expect.poll(() => writes.some(path => path.includes('/grammar/') && path.includes('/groups/g/'))).toBe(true);
  await dialog.getByRole('button', { name: 'B Article', exact: true }).click();
  await expect.poll(() => writes.some(path => path.includes('/grammar/') && path.includes('/groups/gb/'))).toBe(true);
});

test('sentence-mode split and merge appear in full text immediately and after a reload', async ({ page }) => {
  const state = await reviewSetup(page);
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  const actionRow = page.locator('li').filter({ has: page.locator('input[value="行动"]') });
  await actionRow.getByRole('button', { name: 'Split', exact: true }).click();
  await page.locator('input:focus').fill('行 动');
  await page.locator('input:focus').press('Enter');
  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  const article = page.getByTestId('import-full-text-reader').locator('article');
  await expect(article.getByRole('button', { name: '行', exact: true })).toHaveCount(1);
  await expect(article.getByRole('button', { name: '动', exact: true })).toHaveCount(1);
  await expect(article.getByRole('button', { name: '行动', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  await page.locator('li').filter({ has: page.locator('input[value="行"]') }).getByRole('button', { name: 'Merge ↓', exact: true }).click();
  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  await expect(article.getByRole('button', { name: '行动', exact: true })).toHaveCount(1);
  await expect(article.getByRole('button', { name: '行', exact: true })).toHaveCount(0);
  await expect.poll(() => state.saved().items.some((item: any) => item.origin === 'merge' && item.status === 'pending' && item.term === '行动')).toBe(true);
  await page.reload();
  await expect(article.getByRole('button', { name: '行动', exact: true })).toHaveCount(1);
  await expect(article.getByRole('button', { name: '动', exact: true })).toHaveCount(0);
  expect(state.generations()).toBe(0);
});
