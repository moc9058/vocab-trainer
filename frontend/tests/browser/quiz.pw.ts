import { test, expect, type Page } from '@playwright/test';

function fixture(kind: 'word' | 'grammar' = 'word') {
  return {
    sessionId: 'chinese__mixed', language: 'chinese', startedAt: 'start', status: 'in-progress',
    reviewedQuestionCount: 0, initialTotal: 1, score: { correct: 0, total: 1 }, domainWeights: { word: 1, grammar: 1 },
    questions: [kind === 'word' ? { kind, wordId: 'b', term: '总统', definitions: [] } : { kind, grammarId: 'g', statement: '不但～而且～' }],
    wordGroupMembership: kind === 'word' ? { b: ['b'] } : {}, grammarGroupMembership: kind === 'grammar' ? { bg: ['g'] } : {},
    mixedScope: { version: 1, wordA: {}, grammarA: {}, wordB: kind === 'word' ? { b: ['b'] } : {}, grammarB: kind === 'grammar' ? { bg: ['g'] } : {} },
    mixWeights: { category: { A: 1, B: 1 }, domain: { A: { word: 1, grammar: 1 }, B: { word: 1, grammar: 1 } } },
  };
}
async function loadQuiz(page: Page, kind: 'word' | 'grammar' = 'word', continuing = false) {
  const calls: any[] = [];
  const session = fixture(kind);
  if (continuing) {
    session.questions.push({ kind: 'word', wordId: 'a', term: '其他', definitions: [] });
    session.wordGroupMembership = { b: ['b'], a: ['a'] } as any;
    session.initialTotal = 2; session.score.total = 2;
  }
  await page.addInitScript(s => { (window as any).fixture = s; }, session);
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    let json: any;
    if (path === '/api/vocab/chinese/groups') json = [{ id: 'b', name: 'Article', category: 'B', wordIds: ['b'] }, { id: 'outside', name: 'Unselected A', category: 'A', wordIds: ['b'] }];
    else if (path === '/api/grammar/chinese/groups') json = [{ id: 'bg', name: 'Article', category: 'B', grammarIds: ['g'] }];
    else if (path === '/api/quiz/hydrate/chinese') json = { questions: [{ wordId: 'a', term: '其他', definitions: [], examples: [] }, { wordId: 'b', term: '总统', definitions: [{ partOfSpeech: 'noun', text: { en: 'president '.repeat(300) } }], examples: [{ sentence: '总统讲话。'.repeat(80), translation: { en: 'The president speaks.' } }] }] };
    else if (path.endsWith('/items/batch')) json = { items: [{ id: 'g', statement: '不但～而且～', descriptions: [{ partOfSpeech: '', text: { en: 'not only but also '.repeat(300) } }], examples: [] }] };
    else if (path.endsWith('/reviewed')) json = { reviewedQuestionCount: 1 };
    else if (path === '/api/mixed-quiz/answer') { calls.push(route.request().postDataJSON()); json = { session: fixture(kind) }; }
    else { await route.fulfill({ status: 500, json: { error: `Unexpected API ${path}` } }); return; }
    await route.fulfill({ json });
  });
  await page.goto('/tests/browser/harness.html');
  await expect(page.getByRole('button', { name: /Show.*Answer/ })).toBeVisible();
  return calls;
}
async function visibleInsideViewport(page: Page, locator: ReturnType<Page['getByTestId']>) {
  const box = await locator.boundingBox(); const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
}
for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`word controls stay visible at ${viewport.width}×${viewport.height}; final Wrong completes without repeating`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const calls = await loadQuiz(page);
    const actions = page.getByTestId('quiz-actions');
    await expect(actions.getByRole('button', { name: /Remove from Group B$/ })).toBeVisible();
    await visibleInsideViewport(page, actions);
    await page.getByRole('button', { name: 'Show Answer', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await visibleInsideViewport(page, actions);
    await actions.getByRole('button', { name: /Remove from Group B$/ }).click();
    await actions.getByRole('button', { name: 'Wrong', exact: true }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ removeFromGroupB: true, correct: false, startedAt: 'start' });
    expect(calls[0].operationId).toBeTruthy();
    await expect(page.getByText('Quiz Complete!', { exact: true })).toBeVisible();
    await expect(actions).toHaveCount(0);
    await page.getByRole('button', { name: /Review Session/ }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start New', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to Quiz', exact: true })).toHaveCount(0);

  });
}
test('grammar uses the same mobile controls and removal + Correct finishes', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const calls = await loadQuiz(page, 'grammar');
  await page.getByRole('button', { name: /Show.*Answer/ }).click();
  const actions = page.getByTestId('quiz-actions');
  await actions.getByRole('button', { name: /Remove from Group B$/ }).click();
  await actions.getByRole('button', { name: 'Correct', exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ kind: 'grammar', refId: 'g', correct: true, removeFromGroupB: true });
  await expect(actions).toHaveCount(0);
});

test('End session reviews only that sitting and returns to the existing quiz', async ({ page }) => {
  const calls = await loadQuiz(page, 'word', true);
  await page.getByRole('button', { name: 'Show Answer', exact: true }).click();
  await page.getByRole('button', { name: 'Wrong', exact: true }).click();
  await expect(page.getByRole('heading', { name: '其他', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /End Session/i }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start New', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to Quiz', exact: true }).click();
  // Both the untouched question and the previous Wrong are now eligible, in any order.
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Show Answer', exact: true }).click();
    await page.getByRole('button', { name: 'Correct', exact: true }).click();
  }
  await expect(page.getByText('Quiz Complete!', { exact: true })).toBeVisible();
  await expect.poll(() => calls.length).toBe(3);
  expect(new Set(calls.slice(1).map(c => c.refId))).toEqual(new Set(['a', 'b']));
  await page.getByRole('button', { name: /Review Session/ }).click();
  await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start New', exact: true })).toBeVisible();
});
