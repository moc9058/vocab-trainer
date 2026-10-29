import { test, expect } from '@playwright/test';

test('captured comments can be selected separately, corrected, and combined explicitly at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await page.getByRole('button', { name: /^Choose passage 2/ }).click();
  const text = page.getByRole('textbox', { name: 'Check and edit the original text' });
  await expect(text).toHaveValue('确实如此。');
  await text.fill('确实如此！');
  await page.getByLabel('Type of passage', { exact: true }).selectOption('comment');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  let result = JSON.parse(await page.getByTestId('capture-selection').innerText());
  expect(result.text).toBe('确实如此！'); expect(result.blockId).toBe('comment'); expect(result.origin.sourceKind).toBe('comment');
  await page.getByRole('checkbox').first().check();
  await expect(text).toHaveValue('虽然很忙，但我还是来了。\n确实如此。');
  await expect(page.getByText(/You selected several blocks/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/vocab-capture-workspace.png', fullPage: true });
});

test('meaning units open the corresponding word or crossing grammar and preserve registration candidates on update', async ({ page }) => {
  const source = '虽然很忙，但他还是来了。';
  const reading = { version: 1, sourceText: source, explanationLanguage: 'ja', overview: '忙しいが来た。', ambiguityNotes: [],
    comprehension: { meaning: '忙しいが彼は来た。', skeleton: '彼が来た', connection: '背景不明', nuances: [], meaningUnits: { version: 1, units: [
      { text: '虽然很忙，', range: { start: 0, end: 5 }, meaning: '忙しいが', role: '譲歩' }, { text: '但他还是来了。', range: { start: 5, end: 12 }, meaning: 'それでも彼は来た', role: '結論' }], flow: '譲歩から結論へ' } },
    occurrences: [{ id: 's0-o0', range: { start: 0, end: 2 }, surface: '虽然', lemma: '虽然', contextualMeaning: '〜だけれど', transliteration: 'suī rán', explanationLanguage: 'ja', partOfSpeech: '', role: '', reasoning: '', contrast: '', senseKey: '', constructionIds: ['s0-c0'] }],
    constructions: [{ id: 's0-c0', statement: '虽然…但…', ranges: [{ start: 0, end: 2 }, { start: 5, end: 6 }], meaning: '譲歩', roleInSentence: '', elements: [] }] };
  const item = { id: 'word', kind: 'word', sentenceIndex: 0, order: 0, term: '虽然', sourceTerm: '虽然', surface: '虽然', range: { start: 0, end: 2 }, origin: 'llm', status: 'registered', existingWordId: 'keep-word', registrations: { A: { status: 'registered', groupIds: ['a'] } } };
  await page.addInitScript(({ source, reading, item }) => { (window as any).fixture = { id: 'article', language: 'chinese', text: source, title: source, paragraphs: [{ sentences: [{ index: 0, text: source, readingAnalysis: reading }] }], items: [item], groupBNames: ['keep-b'], focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '' }; }, { source, reading, item });
  await page.route('**/api/import/chinese/sessions/article/sentences/0/explanation', route => route.fulfill({ json: { sentenceIndex: 0, readingAnalysis: { ...reading, overview: 'updated' } } }));
  await page.goto('/tests/browser/harness.html?mode=meaning');
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByTestId('import-meaning-units')).toContainText('譲歩から結論へ');
  await page.getByTestId('import-meaning-units').getByRole('button', { name: /虽然 suī rán/ }).click();
  await expect(page.getByRole('button', { name: 'Register 虽然' })).toBeVisible();
  await page.getByRole('button', { name: 'Sentence explanation', exact: true }).click();
  await page.getByTestId('import-meaning-units').getByRole('button', { name: /虽然…但…/ }).first().click();
  await expect(page.getByTestId('import-construction-summary')).toContainText('譲歩');
  await page.getByRole('button', { name: 'Update explanation' }).click();
  await expect.poll(async () => JSON.parse(await page.getByTestId('meaning-session').innerText()).paragraphs[0].sentences[0].readingAnalysis.overview).toBe('updated');
  const saved = JSON.parse(await page.getByTestId('meaning-session').innerText());
  expect(saved.items).toEqual([item]); expect(saved.groupBNames).toEqual(['keep-b']);
  await page.screenshot({ path: '/tmp/vocab-meaning-sheet.png', fullPage: true });
});

test('a captured compact reading automatically loads meaningful parts once when selected', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).fixture = { id: 'article', language: 'chinese', title: '你好。', text: '你好。',
      sourceOrigin: { version: 1, method: 'shared-text', sourceKind: 'comment', textConfirmed: true },
      analysisProgress: { version: 1, chunks: ['你好。'], nextChunk: 1 },
      paragraphs: [{ sentences: [{ index: 0, text: '你好。', readingAnalysis: { version: 1, sourceText: '你好。', explanationLanguage: 'ja', overview: '', ambiguityNotes: [], occurrences: [], constructions: [] } }] }],
      items: [], groupBNames: [], focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '' };
  });
  let calls = 0;
  await page.route('**/api/import/chinese/sessions/article/sentences/0/explanation', route => {
    calls++;
    return route.fulfill({ json: { sentenceIndex: 0, readingAnalysis: { version: 1, sourceText: '你好。', explanationLanguage: 'ja', overview: '挨拶', ambiguityNotes: [], occurrences: [], constructions: [],
      comprehension: { meaning: 'こんにちは', skeleton: '', connection: '', nuances: [], meaningUnits: { version: 1, units: [{ text: '你好。', meaning: 'こんにちは', role: '挨拶', range: { start: 0, end: 3 } }], flow: '一つの挨拶。' } } } } });
  });
  await page.goto('/tests/browser/harness.html?mode=meaning');
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByTestId('import-meaning-units')).toContainText('一つの挨拶。');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByTestId('import-meaning-units')).toBeVisible();
  expect(calls).toBe(1);
});

test('a new input resets metadata and restores its own local draft', async ({ page }) => {
  await page.goto('/tests/browser/harness.html?mode=capture');
  await page.getByRole('button', { name: /^Choose passage 1/ }).click();
  await page.getByRole('textbox', { name: 'Source name (optional)' }).fill('My source');
  await page.getByRole('textbox', { name: 'Check and edit the original text' }).fill('修正した原文。');
  await expect(page.getByTestId('capture-draft')).toContainText('修正した原文。');
  await page.getByRole('button', { name: 'Switch capture' }).click();
  await expect(page.getByRole('textbox', { name: 'Source name (optional)' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Check and edit the original text' })).toHaveValue('臺灣的經濟與发展。');
  await page.getByRole('button', { name: 'Original capture' }).click();
  await expect(page.getByRole('textbox', { name: 'Source name (optional)' })).toHaveValue('My source');
  await expect(page.getByRole('textbox', { name: 'Check and edit the original text' })).toHaveValue('修正した原文。');
});

test('missing input accepts an explicit paste and creates only one local capture while typing', async ({ page }) => {
  await page.addInitScript(() => { (window as any).captureEmpty = true; });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await expect(page.getByText('No passage has been received.', { exact: false }).first()).toBeVisible();
  const text = page.getByRole('textbox', { name: 'Check and edit the original text' });
  await text.fill('https://example.com/article');
  await expect(page.getByRole('button', { name: 'Analyze', exact: true })).toBeDisabled();
  await expect(page.getByText('Only a link was received.', { exact: false })).toBeVisible();
  await text.fill('這段文章');
  await expect(page.getByTestId('capture-draft')).toContainText('這段文章');
  await text.fill('這段文章包含简体字😊。');
  await expect(page.getByTestId('capture-draft')).toContainText('這段文章包含简体字😊。');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByTestId('capture-selection')).toContainText('這段文章包含简体字😊。');
  const result = JSON.parse(await page.getByTestId('capture-selection').innerText());
  expect(result.origin.method).toBe('paste');
  expect(result.origin.sourceLabel).toBeUndefined();
  expect(await page.evaluate(() => (window as any).captureCreates)).toBe(1);
});

test('local draft failure prevents analysis and allows retry without losing the text', async ({ page }) => {
  await page.addInitScript(() => { (window as any).captureText = true; (window as any).captureFailSave = true; });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await expect(page.getByText('The local draft could not be saved.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByTestId('capture-selection')).toHaveText('null');
  await page.evaluate(() => { (window as any).captureFailSave = false; });
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByTestId('capture-selection')).toContainText('臺灣的經濟與发展。');
});

test('a frozen request restores source metadata and provides an explicit new-source action', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).captureText = true;
    const request = { text: '確認した文章。', sourceOrigin: { sourceLabel: 'Known source', sourceKind: 'article', sourceUrl: 'https://example.com' }, groupBNames: ['B'] };
    (window as any).captureFixture = { operations: { text: { request: JSON.stringify(request), createdAt: new Date().toISOString() } } };
  });
  await page.goto('/tests/browser/harness.html?mode=capture');
  const text = page.getByRole('textbox', { name: 'Check and edit the original text' });
  await expect(text).toHaveValue('確認した文章。');
  await expect(text).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Source name (optional)' })).toHaveValue('Known source');
  await page.getByRole('button', { name: 'Create another source from this passage' }).click();
  await expect(text).toBeEnabled();
  await text.fill('別の文章。');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByTestId('capture-selection')).toContainText('別の文章。');
  expect(JSON.parse(await page.getByTestId('capture-selection').innerText()).blockId).toMatch(/^text:/);
});

test('capture confirmation directly starts analysis and a lost creation response reuses the same request', async ({ page }) => {
  let stored: any;
  const requests: any[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sessions') && route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); requests.push(body);
      stored ??= { ...body, id: 'captured-source', language: 'chinese', createdAt: '', updatedAt: '', analysisProgress: { version: 1, chunks: [body.text], nextChunk: 0 } };
      if (requests.length === 1) { await route.abort('connectionreset'); return; }
      await route.fulfill({ status: 200, json: stored }); return;
    }
    if (path.endsWith('/sessions/captured-source')) { await route.fulfill({ json: stored }); return; }
    if (path.endsWith('/analysis-job')) {
      if (route.request().method() === 'POST') {
        stored.analysisJobRef = { version: 2, jobId: stored.id, generation: 1 };
        stored.analysisState = 'running';
      }
      await route.fulfill({ json: { id: stored.id, state: 'running', generation: 1, revision: 1, nextBatch: 0, totalBatches: 1, completedSentences: 0, pauseRequested: false, updatedAt: '' } }); return;
    }
    if (path.endsWith('/sessions')) { await route.fulfill({ json: { sessions: [], pool: { wordIds: [], grammarIds: [] } } }); return; }
    await route.fulfill({ json: [] });
  });
  await page.goto('/tests/browser/harness.html?mode=capture-import&capture=capture-import');
  await expect(page.getByRole('textbox', { name: 'Check and edit the original text' })).toHaveValue('雖然很忙，但我还是来了。');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open or retry this source' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Check and edit the original text' })).toBeDisabled();
  await page.getByRole('button', { name: 'Open or retry this source' }).click();
  await expect(page.getByRole('button', { name: 'Pause after the current part' })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ analyzeAsJob: true, text: '雖然很忙，但我还是来了。', sourceOrigin: { method: 'shared-text', textConfirmed: true } });
});

test('a failed local text receipt can be retried after capacity is available', async ({ page }) => {
  await page.addInitScript(() => { (window as any).captureEmpty = true; (window as any).captureFailReceive = true; });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await page.getByRole('textbox', { name: 'Check and edit the original text' }).fill('保存する原文。');
  await expect(page.getByText('The local draft could not be saved.', { exact: false })).toBeVisible();
  await page.evaluate(() => { (window as any).captureFailReceive = false; });
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByTestId('capture-selection')).toContainText('保存する原文。');
});

test('a captured image can switch to an explicitly pasted passage without reusing its metadata', async ({ page }) => {
  await page.goto('/tests/browser/harness.html?mode=capture');
  await page.getByRole('button', { name: /^Choose passage 1/ }).click();
  await page.getByRole('textbox', { name: 'Source name (optional)' }).fill('Image source');
  await page.getByText('Other input methods', { exact: true }).click();
  await page.getByRole('button', { name: 'Paste another passage' }).click();
  const text = page.getByRole('textbox', { name: 'Check and edit the original text' });
  await expect(text).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Source name (optional)' })).toHaveValue('');
  await text.fill('另一段原文。');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByTestId('capture-selection')).toContainText('另一段原文。');
  expect(JSON.parse(await page.getByTestId('capture-selection').innerText()).origin.method).toBe('paste');
});

test('malformed saved meaning units hide only that block without regenerating the explanation', async ({ page }) => {
  await page.addInitScript(() => {
    const text = '你好。';
    (window as any).fixture = {
      id: 'article', language: 'chinese', title: text, text, items: [], groupBNames: [],
      sourceOrigin: { version: 1, method: 'shared-text', sourceKind: 'comment', textConfirmed: true },
      analysisProgress: { version: 1, chunks: [text], nextChunk: 1 },
      focusedSentenceIndex: 0, status: 'in-progress', createdAt: '', updatedAt: '',
      paragraphs: [{ sentences: [{ index: 0, text, readingAnalysis: {
        version: 1, sourceText: text, explanationLanguage: 'ja', overview: '保存済みの挨拶の説明', ambiguityNotes: [], occurrences: [], constructions: [],
        comprehension: { meaning: '保存済みの挨拶の説明', skeleton: '挨拶', connection: '', nuances: [], meaningUnits: {
          version: 1, units: [{ text, range: { start: 0, end: 1 }, meaning: 'broken', role: 'broken' }], flow: 'broken',
        } },
      } }] }],
    };
  });
  const calls: string[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), async route => { calls.push(route.request().url()); await route.fulfill({ status: 500, json: {} }); });
  await page.goto('/tests/browser/harness.html?mode=meaning');
  await page.getByRole('button', { name: 'Sentence explanation 1', exact: true }).click();
  await expect(page.getByTestId('import-comprehension')).toContainText('保存済みの挨拶の説明');
  await expect(page.getByTestId('import-meaning-units')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Update explanation', exact: true })).toBeEnabled();
  expect(calls).toEqual([]);
});

for (const method of ['shared-image', 'screenshot-shortcut']) {
  test(`${method} automatically analyzes every OCR block once without confirmation`, async ({ page }) => {
    await page.addInitScript(method => { (window as any).captureImageFixture = { method }; }, method);
    await page.goto('/tests/browser/harness.html?mode=capture');
    await expect(page.getByTestId('capture-selection')).toContainText('automatic-ocr');
    const result = JSON.parse(await page.getByTestId('capture-selection').innerText());
    expect(result.text).toBe('虽然很忙，但我还是来了。\n确实如此。');
    expect(result.blockIds).toEqual(['post', 'comment']);
    expect(result.origin).toMatchObject({ method, textConfirmed: false, analysisMode: 'automatic-ocr', sourceKind: 'unknown' });
    expect(result.draft).toMatchObject({ automaticAnalysisStarted: true, descriptionLanguage: 'ja', groupBNames: [] });
    await page.getByRole('button', { name: 'Remount capture' }).click();
    await expect(page.getByRole('textbox', { name: 'Check and edit the original text' })).toHaveValue(result.text);
    expect(await page.evaluate(() => (window as any).captureSubmissions)).toBe(1);
  });
}

test('an image picked inside the app also starts analysis automatically', async ({ page }) => {
  await page.addInitScript(() => { (window as any).captureEmpty = true; (window as any).capturePick = true; });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await page.getByText('Other input methods', { exact: true }).click();
  await page.getByRole('button', { name: 'Choose an image', exact: true }).click();
  await expect(page.getByTestId('capture-selection')).toContainText('automatic-ocr');
  expect(JSON.parse(await page.getByTestId('capture-selection').innerText()).origin.method).toBe('image-picker');
});

for (const text of ['', 'https://example.com', '字'.repeat(8001)]) {
  test(`unusable OCR (${text.length} units) stops for manual correction`, async ({ page }) => {
    await page.addInitScript(text => { (window as any).captureImageFixture = { blocks: text ? [{ id: 'post', text, rects: [], confidence: 1 }] : [] }; }, text);
    await page.goto('/tests/browser/harness.html?mode=capture');
    await expect(page.getByRole('alert')).toContainText('Automatic analysis stopped');
    await expect(page.getByTestId('capture-selection')).toHaveText('null');
    if (text) {
      await page.getByRole('textbox', { name: 'Check and edit the original text' }).fill('修正した文章。');
      await page.getByRole('button', { name: 'Analyze', exact: true }).click();
      await expect(page.getByTestId('capture-selection')).toContainText('修正した文章。');
      expect(JSON.parse(await page.getByTestId('capture-selection').innerText()).origin.textConfirmed).toBe(true);
    }
  });
}

test('OCR failure can be retried explicitly and does not submit before recognition', async ({ page }) => {
  await page.addInitScript(() => { (window as any).captureFailOCR = true; });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('capture-selection')).toHaveText('null');
  await page.evaluate(() => { (window as any).captureFailOCR = false; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('capture-selection')).toContainText('automatic-ocr');
});

test('automatic image analysis stops after a lost creation response and explicitly retries the same request', async ({ page }) => {
  let stored: any;
  const requests: any[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sessions') && route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); requests.push(body);
      stored ??= { ...body, id: 'captured-source', language: 'chinese', createdAt: '', updatedAt: '', analysisProgress: { version: 1, chunks: [body.text], nextChunk: 0 } };
      if (requests.length === 1) { await route.abort('connectionreset'); return; }
      await route.fulfill({ status: 200, json: stored }); return;
    }
    if (path.endsWith('/sessions/captured-source')) { await route.fulfill({ json: stored }); return; }
    if (path.endsWith('/analysis-job')) {
      if (route.request().method() === 'POST') {
        stored.analysisJobRef = { version: 2, jobId: stored.id, generation: 1 };
        stored.analysisState = 'running';
      }
      await route.fulfill({ json: { id: stored.id, state: 'running', generation: 1, revision: 1, nextBatch: 0, totalBatches: 1, completedSentences: 0, pauseRequested: false, updatedAt: '' } }); return;
    }
    if (path.endsWith('/sessions')) { await route.fulfill({ json: { sessions: [], pool: { wordIds: [], grammarIds: [] } } }); return; }
    await route.fulfill({ json: [] });
  });
  await page.addInitScript(() => { (window as any).captureImportFixture = { inputKind: 'image', method: 'screenshot-shortcut', text: undefined, blocks: [{ id: 'post', text: '雖然很忙，但我还是来了。', rects: [], confidence: 1 }] }; });
  await page.goto('/tests/browser/harness.html?mode=capture-import&capture=capture-import');
  await expect(page.getByRole('button', { name: 'Open or retry this source' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Check and edit the original text' })).toBeDisabled();
  await page.getByRole('button', { name: 'Open or retry this source' }).click();
  await expect(page.getByRole('button', { name: 'Pause after the current part' })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ analyzeAsJob: true, text: '雖然很忙，但我还是来了。', sourceOrigin: { method: 'screenshot-shortcut', textConfirmed: false, analysisMode: 'automatic-ocr' } });
});


test('an acknowledged image stays editable through the explicit new-source action', async ({ page }) => {
  await page.addInitScript(() => {
    const draft = { automaticAnalysisStarted: true, blockId: 'automatic-ocr', selected: ['post', 'comment'], text: '全文。', sourceLabel: '', sourceKind: 'unknown', sourceUrl: '', groupBNames: [], descriptionLanguage: 'ja' };
    const request = { text: draft.text, sourceOrigin: { version: 1, method: 'shared-image', sourceKind: 'unknown', textConfirmed: false, analysisMode: 'automatic-ocr' } };
    (window as any).captureImageFixture = { acknowledged: true, draft, operations: { 'automatic-ocr': { request: JSON.stringify(request), sessionId: 'saved', createdAt: new Date().toISOString() } } };
  });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await expect(page.getByRole('button', { name: 'Open or retry this source' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).captureResumes ?? 0)).toBe(0);
  await page.getByRole('button', { name: 'Create another source from this passage' }).click();
  await expect(page.getByRole('textbox', { name: 'Check and edit the original text' })).toBeEnabled();
});

test('automatic image submission waits until its local attempt is durably saved', async ({ page }) => {
  await page.addInitScript(() => { (window as any).captureFailSave = true; });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await expect(page.getByText('The local draft could not be saved.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('capture-selection')).toHaveText('null');
  await page.evaluate(() => { (window as any).captureFailSave = false; });
  await page.getByRole('alert').filter({ hasText: 'could not be opened' }).getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('capture-selection')).toContainText('automatic-ocr');
});
