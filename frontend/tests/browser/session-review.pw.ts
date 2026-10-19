import { test, expect, type Page } from '@playwright/test';
import { applyReviewOperation } from '../../../backend/src/quiz-review';

const cases = [
  { mode: 'word', base: '/api/quiz', language: 'chinese' },
  { mode: 'grammar', base: '/api/grammar-quiz', language: 'chinese' },
  ...['combined', 'mixed', 'importA', 'importB'].map(variant => ({ mode: 'combined', variant,
    base: `/api/${({ combined: 'combined-quiz', mixed: 'mixed-quiz', importA: 'import-quiz-a', importB: 'import-quiz-b' } as Record<string, string>)[variant]}`,
    language: 'chinese' })),
  { mode: 'recall', base: '/api/expression-recall-quiz', language: 'zh' },
];

async function mount(page: Page, config: typeof cases[number], completed = false, owner = false) {
  let saved: any = {
    sessionId: config.language, language: config.language, startedAt: 'saved-test',
    status: completed ? 'completed' : 'in-progress', reviewedQuestionCount: 0,
    score: { correct: 9, total: completed ? 10 : 11 }, initialTotal: completed ? 10 : 11,
    domainWeights: { word: 1, grammar: 1 }, direction: 'phrase-to-context',
    questions: Array.from({ length: completed ? 10 : 11 }, (_, i) => ({
      ...(config.mode === 'grammar' ? { grammarId: `q${i}`, statement: `Grammar ${i + 1}` }
        : config.mode === 'recall' ? { expressionId: `q${i}`, prompt: `Phrase ${i + 1}` }
        : { kind: 'word', wordId: `q${i}`, term: `Word ${i + 1}`, definitions: [] }),
      ...(i < 10 ? { userCorrect: i !== 0 } : {}),
    })),
  };
  // Each page load receives only the server fixture. No local browser session state is used.
  await page.route('**/tests/browser/harness.html*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<head>',
      `<head><script>window.fixture=${JSON.stringify(saved)}</script>`) });
  });
  let lostAction: "start" | "next" | null = null;
  let answerCalls = 0;
  let conflict = false;
  let reviewWrites = 0;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${config.base}/answer`) answerCalls++;
    if (path === `${config.base}/session/language/${config.language}/review`) {
      reviewWrites++;
      const input = route.request().postDataJSON();
      if (conflict) {
        conflict = false;
        saved = applyReviewOperation(saved, { ...input, operationId: 'another-tab' });
        await route.fulfill({ status: 409, json: { message: 'Review changed' } }); return;
      }
      saved = applyReviewOperation(saved, input);
      if (lostAction === input.action) {
        lostAction = null;
        await route.abort('failed'); return;
      }
      await route.fulfill({ json: { session: saved } }); return;
    }
    if (path === `${config.base}/session/language/${config.language}`) {
      await route.fulfill({ json: saved }); return;
    }
    if (path.includes('/hydrate/')) {
      await route.fulfill({ json: { questions: saved.questions.filter((q: any) => q.wordId)
        .map((q: any) => ({ ...q, definitions: [{ text: { en: `Meaning ${q.wordId}` } }], examples: [] })) } }); return;
    }
    if (path.includes('/items/batch')) {
      await route.fulfill({ json: { items: saved.questions.map((q: any) => ({ id: q.grammarId,
        statement: q.statement, descriptions: [], examples: [] })) } }); return;
    }
    if (path.includes('/expressions/') && path.endsWith('/batch')) {
      await route.fulfill({ json: { items: saved.questions.map((q: any) => ({ id: q.expressionId,
        phrase: q.prompt, context: `Context ${q.expressionId}` })) } }); return;
    }
    if (path.endsWith('/ids')) { await route.fulfill({ json: { wordIds: [], count: 0 } }); return; }
    if (path.endsWith('/groups')) { await route.fulfill({ json: [] }); return; }
    await route.fulfill({ status: 500, json: { message: `Unexpected API ${path}` } });
  });
  const url = `/tests/browser/harness.html?mode=${owner ? "recall-view" : config.mode}&variant=${'variant' in config ? config.variant : ''}`;
  await page.goto(url);
  return { get saved() { return saved; }, get writes() { return reviewWrites; }, get answerCalls() { return answerCalls; },
    loseResponse: (action: "start" | "next" = "next") => { lostAction = action; }, conflict: () => { conflict = true; } };
}

for (const config of cases) {
  test(`${config.base}: saves 4 of 10 and resumes at 5 without localStorage`, async ({ page }) => {
    const server = await mount(page, config);
    await page.getByRole('button', { name: /End Session/i }).click();
    await expect(page.getByText('1 / 10', { exact: true })).toBeVisible();
    const order: number[] = [...server.saved.reviewState.questionOrder];
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i));
    const heading = (index: number) => `${config.mode === 'grammar' ? 'Grammar' : config.mode === 'recall' ? 'Phrase' : 'Word'} ${order[index] + 1}`;
    await expect(page.getByRole('heading', { name: heading(0), exact: true })).toBeVisible();
    for (let i = 1; i <= 4; i++) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByText(`${i + 1} / 10`, { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: heading(i), exact: true })).toBeVisible();
    }
    expect(server.saved.reviewedQuestionCount).toBe(0);
    expect(server.saved.score.correct).toBe(9);
    expect(server.saved.questions.length).toBe(11);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByText('5 / 10', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: heading(4), exact: true })).toBeVisible();
    expect(server.saved.reviewState.questionOrder).toEqual(order);
    for (let i = 5; i <= 10; i++) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      if (i < 10) await expect(page.getByText(`${i + 1} / 10`, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Return to Quiz', exact: true })).toBeVisible();
    expect(server.saved.reviewedQuestionCount).toBe(10);
    expect(server.saved.questions.length).toBe(12); // one Wrong retry, once
    await page.getByRole('button', { name: 'Return to Quiz', exact: true }).click();
    await expect(page.getByRole('button', { name: /Show.*Answer/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /End Session/i })).toBeDisabled();
  });
}

test('completed quiz review survives a lost response and never reopens the test', async ({ page }) => {
  const server = await mount(page, cases[0], true);
  await page.getByRole('button', { name: /Review Session/ }).click();
  await expect(page.getByText('1 / 10', { exact: true })).toBeVisible();
  server.loseResponse();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('2 / 10', { exact: true })).toBeVisible();
  expect(server.saved.reviewState.cursor).toBe(1);
  await page.reload();
  await expect(page.getByText('2 / 10', { exact: true })).toBeVisible();
  for (let i = 2; i <= 10; i++) {
    if (i === 10) server.loseResponse();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    if (i < 10) await expect(page.getByText(`${i + 1} / 10`, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Start New', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to Quiz', exact: true })).toHaveCount(0);
  expect(server.saved.status).toBe('completed');
  expect(server.saved.questions.length).toBe(10);
});

test('a conflicting tab requires reload, with no rewind or skipped card', async ({ page }) => {
  const server = await mount(page, cases[0]);
  await page.getByRole('button', { name: /End Session/i }).click();
  await expect(page.getByText('1 / 10', { exact: true })).toBeVisible();
  server.conflict();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText(/review changed on another screen/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('2 / 10', { exact: true })).toBeVisible();
  expect(server.saved.reviewState.cursor).toBe(1);
});

test('recall owner stays mounted while review operations drain', async ({ page }) => {
  const server = await mount(page, cases[cases.length - 1], false, true);
  await page.getByRole('button', { name: /End Session/i }).click();
  await expect(page.getByText('1 / 10', { exact: true })).toBeVisible();
  for (let i = 1; i <= 10; i++) {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    if (i < 10) await expect(page.getByText(`${i + 1} / 10`, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Return to Quiz', exact: true })).toBeVisible();
  expect(server.saved.reviewedQuestionCount).toBe(10);
});

test('keyboard grading is blocked while review start is awaiting confirmation', async ({ page }) => {
  const server = await mount(page, cases[0]);
  await page.getByRole('button', { name: /Show.*Answer/ }).click();
  server.loseResponse('start');
  await page.getByRole('button', { name: /End Session/i }).click();
  await page.keyboard.press('1');
  await page.keyboard.press('2');
  await expect(page.getByText('1 / 10', { exact: true })).toBeVisible();
  expect(server.answerCalls).toBe(0);
  expect(server.saved.score.correct).toBe(9);
});
