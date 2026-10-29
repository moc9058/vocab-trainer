/* Shared pure message/input validation; no browser state. */
function validSelection(text) { return typeof text === 'string' && text.trim().length > 0 && text.length <= 8000; }
function sourceDetails(url, title) {
  const u = new URL(url);
  const sourceLabel = String(title ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 100);
  u.username = ''; u.password = ''; u.search = ''; u.hash = '';
  return { ...(sourceLabel ? { sourceLabel } : {}), ...(u.protocol === 'https:' ? { sourceUrl: u.href } : {}) };
}
function allowedApi(method, path, body) {
  if (typeof path !== 'string' || /[%\\?#\u0000-\u0020]/u.test(path) || path.split('/').some(p => p === '.' || p === '..')) return false;
  if (body !== undefined && (typeof body !== 'string' || new TextEncoder().encode(body).length > 900000)) return false;
  if (!EXTENSION_ROUTES.some(([m, pattern]) => method === m && new RegExp(`^${pattern}$`).test(path))) return false;
  if (method === 'GET') return body === undefined;
  try {
    const value = JSON.parse(body ?? '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') return false;
    if (/\/groups\/[^/]+\/(words|grammar)$/.test(path)) return value.action === 'add' && Array.isArray(value.wordIds ?? value.grammarIds);
    if (path === '/api/import/chinese/sessions') return validSelection(value.text) && value.analyzeAsJob === true &&
      Array.isArray(value.paragraphs) && value.paragraphs.length === 0 && Array.isArray(value.items) && value.items.length === 0 &&
      value.sourceOrigin?.method === 'safari-selection' && /^[0-9a-f-]{36}$/i.test(value.ingestionId);
    const keys = (...names) => Object.keys(value).every(k => names.includes(k));
    if (/\/groups$/.test(path)) return keys('name', 'category') && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 500 && (value.category === undefined || ['A', 'B'].includes(value.category));
    if (/\/check-terms$/.test(path)) return keys('terms') && Array.isArray(value.terms) && value.terms.every(t => typeof t === 'string');
    if (/\/items\/batch$/.test(path)) return keys('ids') && Array.isArray(value.ids) && value.ids.every(id => typeof id === 'string');
    if (/\/drafts$/.test(path)) return keys('drafts') && Array.isArray(value.drafts);
    if (/\/vocab\/chinese\/smart-add$/.test(path)) return keys('term', 'sourceContext', 'transliteration', 'definitions', 'topics', 'examples', 'level', 'flag') && typeof value.term === 'string' && !!value.term.trim();
    if (/\/grammar\/chinese\/smart-add$/.test(path)) return keys('id', 'statement', 'sourceContext', 'transliteration', 'descriptions', 'examples', 'exampleIds', 'words', 'level', 'tags') && typeof value.statement === 'string' && Array.isArray(value.descriptions);
    if (/\/analysis-job(?:\/(?:pause|resume))?$/.test(path)) return keys('idempotencyKey', 'analysisRevision') && typeof value.idempotencyKey === 'string' && value.idempotencyKey.length <= 200;
    if (/\/explanation$/.test(path) || path === '/api/auth/extension/revoke') return keys();
    if (method === 'PUT') return keys('title', 'contentRevision', 'analysisRevision', 'analysisCheckpoint', 'items', 'paragraphs', 'wordGroupId', 'grammarGroupId', 'groupBNames', 'focusedSentenceIndex', 'status') && Number.isInteger(value.contentRevision);
    if (/\/revisions$/.test(path)) return keys('kind', 'sentenceIndices', 'update', 'instruction', 'explanationLanguage', 'expectedRevision', 'idempotencyKey', 'conversion') && typeof value.idempotencyKey === 'string';
    if (/\/revisions\/[^/]+\/(?:apply|reject|undo|restore)$/.test(path)) return keys('expectedRevision', 'changeIds', 'sentenceIndices') && Number.isInteger(value.expectedRevision);
    if (/\/candidate-conversions$/.test(path)) return keys('conversion', 'expectedRevision', 'idempotencyKey') && Number.isInteger(value.expectedRevision);
    return false;
  } catch { return false; }
}
