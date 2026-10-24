import { test, expect } from '@playwright/test';

test('captured comments can be selected separately, corrected, and combined explicitly at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/tests/browser/harness.html?mode=capture');
  await page.getByRole('button', { name: /^Choose passage 2/ }).click();
  const text = page.getByRole('textbox', { name: 'Check and edit the original text' });
  await expect(text).toHaveValue('确实如此。');
  await text.fill('确实如此！');
  await page.getByLabel('Type of passage', { exact: true }).selectOption('comment');
  await page.getByRole('button', { name: 'Use this passage' }).click();
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
