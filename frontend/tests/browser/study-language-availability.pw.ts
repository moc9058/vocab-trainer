import { test, expect, type Page } from '@playwright/test';

const languages = [
  { filename: 'english.json', language: 'English', wordCount: 12, topics: [] },
  { filename: 'chinese.json', language: 'Chinese', wordCount: 25, topics: [] },
];
const pauseTitle = 'The English version is temporarily unavailable';

async function mockApp(page: Page) {
  const requests: string[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === '/api/auth/me') await route.fulfill({ json: { authEnabled: false, authenticated: true, user: null } });
    else if (path === '/api/languages/') await route.fulfill({ json: languages });
    else if (path === '/api/translation/history') await route.fulfill({ json: { entries: [], total: 0 } });
    else await route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return requests;
}

test('selectors disable English and keyboard navigation still opens Chinese', async ({ page }) => {
  await mockApp(page);
  await page.goto('/');
  const english = page.getByRole('button', { name: /English.*Temporarily unavailable/ });
  await expect(english).toBeDisabled();
  const chinese = page.getByRole('button', { name: /Chinese/ });
  await expect(chinese).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(chinese).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/chinese$/);
  await expect(page.getByRole('heading', { name: pauseTitle })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'EN', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'JA', exact: true }).click();
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('button', { name: /Languages/ })).toBeVisible();

  await page.goto('/tests/browser/harness.html?mode=language-select');
  await expect(page.getByRole('button', { name: /English.*Temporarily unavailable/ })).toBeDisabled();
  await page.getByRole('button', { name: /Chinese/ }).click();
  await expect(page).toHaveTitle('chinese');
});

test('all English child routes stop before session recovery or learning reads', async ({ page }) => {
  const requests = await mockApp(page);
  for (const path of ['', '/quiz', '/grammar-quiz', '/combined-quiz', '/mixed-quiz', '/import-quiz-a', '/import-quiz-b', '/browse', '/grammar', '/import', '/translation', '/speaking-writing', '/expression-quiz', '/expression-recall', '/expressions', '/flagged', '/print-worksheet']) {
    await page.goto(`/english${path}`);
    await expect(page.getByRole('heading', { name: pauseTitle })).toBeVisible();
  }
  for (const path of ['/en/quiz', '/EN/import', '/English/browse', '/%65nglish/quiz']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: pauseTitle })).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: pauseTitle })).toBeVisible();
  expect(requests.every(path => path === '/api/auth/me')).toBe(true);
  await page.getByRole('link', { name: /Languages/ }).click();
  await expect(page.getByRole('button', { name: /English/ })).toBeDisabled();
  await page.goBack();
  await expect(page.getByRole('heading', { name: pauseTitle })).toBeVisible();
});

test('Chinese translation still offers English and retains English settings', async ({ page }) => {
  await mockApp(page);
  await page.goto('/chinese/translation');
  await expect(page.getByRole('button', { name: 'English', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: pauseTitle })).toHaveCount(0);
});

test('English queued answers survive pause/home navigation and retry serially with unload protection', async ({ page }) => {
  await mockApp(page);
  let online = false;
  const saved: string[] = [];
  await page.route('**/api/quiz/answer', async route => {
    if (!online) { await route.abort(); return; }
    saved.push(route.request().postDataJSON().wordId);
    await route.fulfill({ json: { session: {} } });
  });
  await page.goto('/english/quiz');
  await expect(page.getByRole('heading', { name: pauseTitle })).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = '/src/utils/answerOutbox.ts';
    const { enqueueAnswer } = await import(modulePath);
    enqueueAnswer({ domain: 'word', sessionId: 'english', wordId: 'one', correct: true });
    enqueueAnswer({ domain: 'word', sessionId: 'english', wordId: 'two', correct: false });
  });
  await expect(page.getByRole('button', { name: '2 answers not yet saved', exact: true })).toBeVisible();
  const prevented = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(await prevented()).toBe(true);
  await page.getByRole('link', { name: /Languages/ }).click();
  await expect(page.getByRole('button', { name: /English/ })).toBeDisabled();
  expect(await prevented()).toBe(true);
  await page.goBack();
  await expect(page.getByRole('button', { name: '2 answers not yet saved', exact: true })).toBeVisible();
  online = true;
  await page.getByRole('button', { name: '2 answers not yet saved', exact: true }).click();
  await expect.poll(() => saved).toEqual(['one', 'two']);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(await prevented()).toBe(false);
});

test('pause screen reports permanently rejected answers and allows acknowledgment', async ({ page }) => {
  await mockApp(page);
  await page.route('**/api/quiz/answer', route => route.fulfill({ status: 403, json: { error: 'Rejected' } }));
  await page.goto('/english');
  await expect(page.getByRole('heading', { name: pauseTitle })).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = '/src/utils/answerOutbox.ts';
    const { enqueueAnswer } = await import(modulePath);
    enqueueAnswer({ domain: 'word', sessionId: 'english', wordId: 'one', correct: true });
  });
  await page.getByRole('button', { name: "1 answers couldn't be saved", exact: true }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
});

for (const [lang, title] of [['ja', '英語版は機能改修のため一時停止中です'], ['ko', '영어 버전은 기능 개편을 위해 일시 중지되었습니다']]) {
  test(`pause notice is translated in ${lang}`, async ({ page }) => {
    await mockApp(page);
    await page.addInitScript(lang => localStorage.setItem('uiLanguage', lang), lang);
    await page.goto('/english');
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  });
}
