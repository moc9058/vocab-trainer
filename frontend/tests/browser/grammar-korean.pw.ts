import { test, expect } from '@playwright/test';

for (const mode of ['grammar', 'combined']) {
  test(`${mode} quiz displays persisted Korean grammar descriptions`, async ({ page }) => {
    const fixture = { sessionId: 'chinese', language: 'chinese', startedAt: 'grammar-ko', status: 'in-progress', reviewedQuestionCount: 0,
      initialTotal: 1, score: { correct: 0, total: 1 }, domainWeights: { word: 0, grammar: 1 },
      questions: [{ kind: 'grammar', grammarId: 'g-ko', statement: '把+O+V' }] };
    await page.addInitScript(data => { (window as any).fixture = data; }, fixture);
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/items/batch')) await route.fulfill({ json: { items: [{ id: 'g-ko', statement: '把+O+V', descriptions: [
        { partOfSpeech: '', text: { ja: '対象に対する処置を表す。', ko: '대상에 대한 처리나 결과를 나타낸다.' } },
      ], examples: [] }] } });
      else if (path.endsWith('/groups')) await route.fulfill({ json: [] });
      else await route.fulfill({ status: 404, json: { error: 'Not found' } });
    });
    await page.goto(`/tests/browser/harness.html?mode=${mode}`);
    await page.getByRole('button', { name: /Show.*Answer/ }).click();
    await expect(page.getByText('대상에 대한 처리나 결과를 나타낸다.')).toBeVisible();
    await expect(page.getByText('対象に対する処置を表す。')).toBeVisible();
  });
}
