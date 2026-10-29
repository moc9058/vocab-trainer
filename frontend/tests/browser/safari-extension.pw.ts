import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test('selection button sends only an explicit click, preserves text and rejects inputs/overlong selection', async ({ page }) => {
  await page.goto('/tests/browser/harness.html');
  await page.setContent('<p id="text" style="white-space:pre-wrap">繁體与简体😀\n下一行。</p><input id="input" value="秘密"><p id="long"></p>');
  await page.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { return attach.call(this, { ...options, mode: 'open' }); };
    (window as any).messages = [];
    (window as any).browser = { i18n: { getUILanguage: () => 'en', getMessage: (key: string) => key === 'safariAnalyze' ? 'Analyze' : 'Vocab' }, runtime: {
      async sendMessage(m: unknown) { (window as any).messages.push(m); return { error: 'fixture' }; },
      onMessage: { addListener() {} },
    } };
    window.alert = () => {};
  });
  await page.addScriptTag({ path: resolve(__dirname, '../../../extensions/safari/src/content.js') });
  const choose = async (id: string) => page.evaluate(id => {
    const node = document.getElementById(id)!; const range = document.createRange(); range.selectNodeContents(node);
    const s = getSelection()!; s.removeAllRanges(); s.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  }, id);
  await choose('text');
  const analyze = page.getByRole('button', { name: 'Analyze', exact: true });
  await expect(analyze).toBeVisible();
  expect(await page.evaluate(() => (window as any).messages.length)).toBe(0);
  await analyze.click();
  await expect.poll(() => page.evaluate(() => (window as any).messages.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).messages[0].text)).toBe('繁體与简体😀\n下一行。');
  await page.evaluate(() => { const input = document.getElementById('input') as HTMLInputElement; input.focus(); input.select(); document.dispatchEvent(new Event('selectionchange')); });
  await expect(analyze).toBeHidden();
  await page.evaluate(() => { (document.activeElement as HTMLElement).blur(); document.getElementById('long')!.textContent = '字'.repeat(8001); });
  await choose('long'); await expect(analyze).toBeVisible(); await analyze.click();
  expect(await page.evaluate(() => (window as any).messages.length)).toBe(1);
});

test('extension panel freezes ingestion, starts durable analysis, lazily explains and saves using shared UI', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('uiLanguage', 'en');
    const original = '你好。';
    let context: any = { text: original, source: { sourceLabel: 'Article', sourceUrl: 'https://example.org/article' }, ingestionId: '9e1e5b52-6bb7-4534-9f40-18b77a3e12b5', jobKey: 'job-key', expiresAt: Date.now() + 60000 };
    let session: any;
    (window as any).calls = [];
    (window as any).browser = { runtime: { async sendMessage(m: any) {
      (window as any).calls.push(m);
      if (m.type === 'status') return { connected: true };
      if (m.type === 'get-context') return context;
      if (m.type === 'save-operation') { context = { ...context, request: m.request ?? context.request, sessionId: m.sessionId ?? context.sessionId }; return { ok: true }; }
      if (m.type !== 'api') return { ok: true };
      const body = m.body ? JSON.parse(m.body) : null; let result: any = {};
      if (m.path.endsWith('/groups')) result = [];
      else if (m.path === '/api/grammar/settings') result = { defaultDefinitionLanguage: 'ja' };
      else if (m.path.endsWith('/revisions')) result = { revisions: [] };
      else if (m.path.endsWith('/sessions') && m.method === 'GET') result = { sessions: [], pool: { wordIds: [], grammarIds: [] } };
      else if (m.path.endsWith('/sessions') && m.method === 'POST') { session = { ...body, id: 'article', language: 'chinese', createdAt: '', updatedAt: '', contentRevision: 0 }; result = session; }
      else if (m.path.endsWith('/analysis-job')) {
        session = { ...session, paragraphs: [{ sentences: [{ index: 0, text: original, readingAnalysis: { version: 1, sourceText: original, explanationLanguage: 'ja', overview: '', ambiguityNotes: [], occurrences: [], constructions: [] } }] }], analysisJobRef: { version: 2, jobId: 'article', generation: 1 }, analysisProgress: { version: 1, chunks: [original], nextChunk: 1 }, analysisState: 'completed' };
        result = { id: 'article', generation: 1, state: 'completed', revision: 1, nextBatch: 1, totalBatches: 1, completedSentences: 1, pauseRequested: false, updatedAt: '' };
      } else if (m.path.endsWith('/explanation')) result = { sentenceIndex: 0, readingAnalysis: { version: 1, sourceText: original, explanationLanguage: 'ja', overview: '挨拶', ambiguityNotes: [], occurrences: [], constructions: [], comprehension: { meaning: 'こんにちは', skeleton: '', connection: '', nuances: [], meaningUnits: { version: 1, units: [{ text: original, meaning: 'こんにちは', role: '挨拶', range: { start: 0, end: 3 } }], flow: '一つの挨拶。' } } } };
      else if (m.path.endsWith('/sessions/article')) { if (m.method === 'PUT') session = { ...session, ...body, contentRevision: (session.contentRevision ?? 0) + 1 }; result = session; }
      else throw new Error(`Unexpected ${m.method} ${m.path}`);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) };
    } } };
  });
  await page.goto('/panel.html?context=test-context');
  await expect(page.getByText('你好。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByTestId('import-full-text-reader')).toBeVisible();
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByTestId('import-meaning-units')).toContainText('一つの挨拶。');
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((m: any) => m.type === 'api' && m.method === 'PUT').length)).toBeGreaterThan(0);
  const calls = await page.evaluate(() => (window as any).calls);
  const create = calls.find((m: any) => m.type === 'api' && m.method === 'POST' && m.path.endsWith('/sessions'));
  expect(calls.filter((m: any) => m.type === 'api' && m.method === 'POST' && m.path.endsWith('/sessions')).length).toBe(1);
  expect(JSON.parse(create.body).ingestionId).toBe('9e1e5b52-6bb7-4534-9f40-18b77a3e12b5');
  expect(JSON.parse(create.body).sourceOrigin.method).toBe('safari-selection');
  expect(calls.findIndex((m: any) => m.type === 'save-operation' && m.request)).toBeLessThan(calls.indexOf(create));
  expect(calls.some((m: any) => m.type === 'api' && /smart-add/.test(m.path))).toBe(false);
  expect(calls.filter((m: any) => m.type === 'api' && /explanation$/.test(m.path)).length).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Web approval returns to the request after sign-in and requires an explicit matching-code approval', async ({ page }) => {
  const id = 'r'.repeat(43); let authenticated = false, approved = false;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { authEnabled: true, authenticated, user: authenticated ? { email: 'owner@example.test' } : null } });
    if (path === '/api/auth/extension/connections') return route.fulfill({ json: { connections: [] } });
    if (path === `/api/auth/extension/request/${id}`) return route.fulfill({ json: { code: 'ABC12345', expiresAt: Date.now() + 60000, approved: false } });
    if (path === '/api/auth/extension/approve') {
      expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({ id, code: 'ABC12345' });
      expect(route.request().headers().origin).toBe('http://127.0.0.1:4174');
      approved = true; return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`/extension/connect?id=${id}`);
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('safariConnectionReturn') ?? 'null')?.id)).toBe(id);
  authenticated = true; await page.goto('/');
  await expect(page.getByText('ABC12345', { exact: true })).toBeVisible();
  expect(approved).toBe(false);
  await page.getByRole('button', { name: 'Connect Safari extension', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approved. Return to the extension.' })).toBeDisabled();
  expect(approved).toBe(true);
});
