import { test, expect } from '@playwright/test';

test('word API transport sends explicit A and B targets without stripping them', async ({ page }) => {
  let submitted: unknown;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/vocab/chinese/smart-add') {
      submitted = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { id: 'created', term: '后悔', definitions: [], examples: [], topics: [] } });
    } else if (path === '/api/auth/me') await route.fulfill({ json: { authEnabled: false, authenticated: true, user: null } });
    else if (path === '/api/languages/') await route.fulfill({ json: [] });
    else await route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { smartAddWord } = await import('/src/api/vocab.ts');
    return smartAddWord('chinese', { term: '后悔', groupIds: ['chosen-a'], groupBIds: ['chosen-b'] });
  });
  expect(result.id).toBe('created');
  expect(submitted).toEqual({ term: '后悔', groupIds: ['chosen-a'], groupBIds: ['chosen-b'] });
});
