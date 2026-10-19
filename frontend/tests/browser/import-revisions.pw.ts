import { test, expect, type Page } from '@playwright/test';
import fixture from '../../src/utils/__fixtures__/import-context.json';
import { syncConvertedWordReading } from '../../src/utils/importWordLinks';
import { buildImportItems } from '../../src/utils/importSession';

async function setup(page: Page, lostAcceptance = false) {
  let session: any = { id: 'article', language: 'chinese', title: 'Revision example', text: fixture.paragraphs.map(p => p.sentences.map(s => s.text).join('')).join('\n'), paragraphs: structuredClone(fixture.paragraphs),
    items: buildImportItems(fixture as any, {}, {}, 'chinese'), contentRevision: 0, groupBNames: [], status: 'in-progress', focusedSentenceIndex: 0, createdAt: '', updatedAt: '' };
  let original = structuredClone(session), calls = 0, conversions = 0, request: any;
  const revisions = new Map<string, any>();
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method(), body = method === 'POST' || method === 'PUT' ? route.request().postDataJSON() : null;
    if (path === '/api/import/chinese/sessions/article') {
      if (method === 'PUT') { session = { ...session, ...body, contentRevision: session.contentRevision + 1 }; }
      await route.fulfill({ json: session }); return;
    }
    if (path.endsWith('/revisions') && method === 'GET') { await route.fulfill({ json: { revisions: [...revisions.values()] } }); return; }
    if (path.endsWith('/revisions') && method === 'POST') {
      request = body;
      if (![...revisions.values()].some(r => r.request.idempotencyKey === body.idempotencyKey)) {
        calls++;
        const g = session.items.find((i: any) => i.kind === 'grammar' && i.sentenceIndex === body.sentenceIndices[0]);
        const sentences = session.paragraphs.flatMap((p: any) => p.sentences).filter((s: any) => body.sentenceIndices.includes(s.index)).map((s: any) => ({ ...s, readingAnalysis: { ...s.readingAnalysis,
          candidatesManaged: true, comprehension: { meaning: 'その会社はそろそろ行動するべきだ。', skeleton: 'その会社が行動する', connection: '前後の文脈は不十分', nuances: [{ text: '行動を促す', evidence: '该', certainty: 'inferred' }] } } }));
        revisions.set('proposal', { id: 'proposal', sessionId: 'article', kind: body.kind, state: 'queued', request: body, targets: sentences.map((s: any) => ({ sentenceIndex: s.index, sourceText: s.text, sourceTextHash: 'test' })), context: [],
          changes: body.kind === 'word-assist' ? [] : [{ id: 'new-grammar', sentenceIndex: g.sentenceIndex, action: 'replace', previousId: g.id, before: g, after: { ...g, id: 'new-grammar', description: '再生成した意味', revisionId: 'proposal' } }], sentences,
          ...(body.kind === 'word-assist' ? { assistedWord: { term: '该', meaning: 'そろそろ〜すべき', transliteration: 'gāi' } } : {}), createdAt: '2026-10-18', updatedAt: '2026-10-18' });
        session.activeRevisionId = 'proposal';
      }
      if (lostAcceptance) { lostAcceptance = false; await route.abort('connectionreset'); return; }
      await route.fulfill({ status: 202, json: revisions.get('proposal') }); return;
    }
    if (path.endsWith('/candidate-conversions')) {
      conversions++; original = structuredClone(session);
      const input = body.conversion, source = session.items.find((i: any) => i.id === input.itemId);
      if (source.kind === 'grammar' && input.mode === 'replace') source.hiddenByRevision = 'conversion';
      const word = { id: 'converted-word', kind: 'word', origin: 'manual', edited: true, status: 'pending', sentenceIndex: source.sentenceIndex, order: input.start, term: input.term, surface: session.paragraphs[0].sentences[0].text.slice(input.start, input.end), sourceTerm: input.term,
        range: { start: input.start, end: input.end }, meaning: input.meaning, transliteration: input.transliteration, explanationLanguage: input.explanationLanguage, convertedFromGrammarId: source.id, revisionId: 'conversion' };
      if (source.kind === 'word') { source.meaning = input.meaning; source.transliteration = input.transliteration; source.explanationLanguage = input.explanationLanguage; } else session.items.push(word);
      session.paragraphs = session.paragraphs.map((p: any) => ({ ...p, sentences: p.sentences.map((sentence: any) => syncConvertedWordReading(sentence, session.items)) }));
      session.contentRevision++;
      const r = { id: 'conversion', sessionId: 'article', kind: 'conversion', state: 'applied', request: { instruction: '', sentenceIndices: [0], update: 'grammar' }, targets: [{ sentenceIndex: 0 }], context: [], changes: [], sentences: [], createdAt: '', updatedAt: '' };
      revisions.set(r.id, r); await route.fulfill({ json: { session, revision: r } }); return;
    }
    const match = path.match(/\/revisions\/([^/]+)(?:\/(apply|reject|undo|restore))?$/);
    if (match) {
      const r = revisions.get(match[1]);
      if (!r) { await route.fulfill({ status: 404, json: { message: 'Missing revision' } }); return; }
      if (!match[2]) { r.state = r.state === 'queued' ? 'proposed' : r.state; delete session.activeRevisionId; await route.fulfill({ json: r }); return; }
      if (match[2] === 'apply') {
        original = structuredClone(session);
        if (body.changeIds.length) { session.items.find((i: any) => i.id === r.changes[0].previousId).hiddenByRevision = r.id; session.items.push(r.changes[0].after); }
        for (const p of session.paragraphs) p.sentences = p.sentences.map((s: any) => body.sentenceIndices.includes(s.index) ? r.sentences.find((n: any) => n.index === s.index) : s);
        r.state = 'applied'; session.contentRevision++;
      } else if (match[2] === 'undo') { session = { ...original, contentRevision: session.contentRevision + 1 }; r.state = 'undone'; }
      else r.state = 'rejected';
      await route.fulfill({ json: { session, revision: r } }); return;
    }
    if (path.endsWith('/check-terms')) { await route.fulfill({ json: { existing: {} } }); return; }
    await route.fulfill({ json: [] });
  });
  await page.goto('/tests/browser/harness.html?mode=import-review');
  await expect(page.getByTestId('import-full-text-reader')).toBeVisible();
  return { saved: () => session, calls: () => calls, conversions: () => conversions, request: () => request };
}

test('selects a sentence, compares generated explanations and candidates, applies and undoes without changing source', async ({ page }) => {
  const state = await setup(page); const source = state.saved().text;
  await page.getByRole('button', { name: 'Revise selected sentences', exact: true }).click();
  await page.getByLabel('Correction instruction (optional)').fill('文全体の意味を簡単に');
  await page.getByRole('button', { name: 'Generate proposal', exact: true }).click();
  const proposal = page.getByTestId('import-revision-proposal');
  await expect(proposal).toContainText('Ready to compare');
  await expect(proposal).toContainText('その会社はそろそろ行動するべきだ。');
  await proposal.screenshot({ path: '/tmp/vocab-revision-proposal.png' });
  expect(state.saved().items.some((i: any) => i.id === 'new-grammar')).toBe(false);
  await page.getByRole('button', { name: 'Apply selected changes' }).click();
  await expect(proposal).toContainText('Applied');
  expect(state.saved().text).toBe(source); expect(state.saved().items.some((i: any) => i.id === 'new-grammar')).toBe(true);
  await page.getByText('Revision history', { exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(proposal).toContainText('Undone'); expect(state.saved().text).toBe(source); expect(state.calls()).toBe(1);
});

test('grammar to word works manually at 360px, preserves construction explanations, and undo restores the candidate', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 }); const state = await setup(page);
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  await page.getByRole('button', { name: 'Treat as a word', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Treat as a word', exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('Word / dictionary form')).toHaveValue('该');
  await page.screenshot({ path: '/tmp/vocab-revision-conversion-mobile.png' });
  const reading = dialog.getByLabel('Reading', { exact: true });
  await reading.fill(''); await reading.pressSequentially('gai3'); await expect(reading).toHaveValue('gǎi');
  await dialog.getByRole('button', { name: 'à', exact: true }).click(); await expect(reading).toHaveValue('gǎià');
  await reading.fill('gāi');
  await dialog.getByLabel('Meaning here', { exact: true }).fill('すべき');
  await dialog.getByRole('button', { name: 'Save word candidate', exact: true }).click();
  await expect(dialog).not.toBeVisible(); expect(state.conversions()).toBe(1); expect(state.calls()).toBe(0);
  const word = state.saved().items.find((i: any) => i.id === 'converted-word'); expect(word.registrations).toBeUndefined(); expect(word.range).toEqual({ start: 3, end: 4 });
  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  const reader = page.getByTestId('import-full-text-reader'); await reader.getByRole('button', { name: '该', exact: true }).nth(1).click();
  await expect(page.getByRole('dialog')).toContainText('すべき');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('word-assist generation is optional and requires explicit use before candidate save', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  await page.getByRole('button', { name: 'Treat as a word', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Treat as a word', exact: true });
  await dialog.getByRole('button', { name: 'Suggest reading and meaning' }).click();
  await expect(dialog.getByRole('button', { name: 'Use this suggestion' })).toBeVisible();
  expect(state.conversions()).toBe(0);
  await dialog.getByRole('button', { name: 'Use this suggestion' }).click();
  await expect(dialog.getByLabel('Meaning here', { exact: true })).toHaveValue('そろそろ〜すべき');
  await dialog.getByRole('button', { name: 'Save word candidate' }).click();
  expect(state.conversions()).toBe(1); expect(state.request().kind).toBe('word-assist');
});

test('lost revision acceptance can be retried with the same operation key and one generation', async ({ page }) => {
  const state = await setup(page, true);
  await page.getByRole('button', { name: 'Revise selected sentences', exact: true }).click();
  await page.getByRole('button', { name: 'Generate proposal' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('import-revision-proposal')).toContainText('Ready to compare'); expect(state.calls()).toBe(1);
});


test('converted words can generate and save reading and meaning again, with linked grammar synchronized after reload', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Sentence mode', exact: true }).click();
  await page.getByRole('button', { name: 'Treat as a word', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save word candidate' }).click();
  const length = state.saved().items.length;
  await page.getByRole('button', { name: 'Edit reading and meaning', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit reading and meaning' });
  await expect(dialog.getByLabel('Word / dictionary form')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Suggest reading and meaning' }).click();
  await dialog.getByRole('button', { name: 'Use this suggestion' }).click();
  await expect(dialog.getByLabel('Reading', { exact: true })).toHaveValue('gāi');
  await dialog.getByRole('button', { name: 'Save word candidate' }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.saved().items.length).toBe(length);
  expect(state.saved().items.find((i: any) => i.id === 'converted-word').meaning).toBe('そろそろ〜すべき');
  expect(state.saved().paragraphs[0].sentences[0].readingAnalysis.constructions[0].statement).toBe('x + v + 了');
  await page.reload();
  await page.getByRole('button', { name: 'Full text', exact: true }).click();
  const reader = page.getByTestId('import-full-text-reader');
  await reader.getByRole('button', { name: '该', exact: true }).nth(1).click();
  const detail = page.getByRole('dialog');
  await expect(detail).toContainText('そろそろ〜すべき');
  await expect(detail.getByRole('button', { name: 'x + v + 了', exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Edit reading and meaning', exact: true })).toBeVisible();
  await detail.getByText('Structure and roles', { exact: true }).click();
  const part = page.getByTestId('import-construction-parts').locator('div').filter({ has: page.locator('span', { hasText: /^该$/ }) }).first();
  await expect(part).toContainText('gāi');
});
