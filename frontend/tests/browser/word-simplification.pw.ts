import { test, expect } from '@playwright/test';

test('word forms and browse omit category and flags; old review bookmarks redirect', async ({ page }) => {
  const requests: string[] = [];
  const word = { id: 'w', term: '测试', definitions: [{ partOfSpeech: 'legacy-word-pos', text: { en: 'test word' } }], topics: [], examples: [], transliteration: 'cèshì' };
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    let json: unknown;
    if (path === '/api/auth/me') json = { authEnabled: false, authenticated: true, user: null };
    else if (path === '/api/languages/') json = [{ filename: 'chinese.json', language: 'Chinese', wordCount: 1, topics: [] }];
    else if (path === '/api/vocab/chinese') json = { items: [word], total: 1, page: 1, limit: 50, totalPages: 1 };
    else if (path === '/api/vocab/chinese/w') json = word;
    else if (path === '/api/vocab/chinese/filters') json = { topics: [], levels: [] };
    else if (path === '/api/vocab/chinese/groups') json = [{ id: 'a', name: 'Library', wordIds: ['w'] }];
    else if (path === '/api/vocab/chinese/drafts') json = [];
    else if (path === '/api/progress/chinese') json = { words: {} };
    else if (path === '/api/translation/history') json = { entries: [], total: 0 };
    else { await route.fulfill({ status: 404, json: { error: 'Not found' } }); return; }
    await route.fulfill({ json });
  });
  await page.goto('/chinese/flagged');
  await expect(page).toHaveURL(/\/chinese\/browse$/);
  await expect(page.getByRole('cell', { name: 'test word', exact: true })).toBeVisible();
  await expect(page.getByText('legacy-word-pos')).toHaveCount(0);
  await expect(page.getByText('Category', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Flag for review|Flagged only|Review Flagged/)).toHaveCount(0);
  await page.getByRole('button', { name: /Add Word/, exact: true }).click();
  await expect(page.getByText('Category', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Flag for review', { exact: true })).toHaveCount(0);
  await expect(page.locator('select').filter({ has: page.locator('option', { hasText: 'LLM will generate' }) })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('cell', { name: /测试/ }).click();
  await page.getByRole('button', { name: 'Edit Word', exact: true }).click();
  await expect(page.getByPlaceholder('Category', { exact: true })).toHaveCount(0);
  await expect(page.getByText('legacy-word-pos')).toHaveCount(0);
  expect(requests.some(path => path.startsWith('/api/flagged'))).toBe(false);
});
