/* Only this background script communicates with the API or Keychain. */
const API_ORIGIN = 'https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app';
const HOST = 'app.vocabtrainer.safari';
const PANEL = browser.runtime.getURL('panel.html');
const random = () => { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const vault = async (action, key, value) => {
  const r = await browser.runtime.sendNativeMessage(HOST, { action, key, ...(value === undefined ? {} : { value }) });
  if (!r || r.error) throw new Error('Secure storage unavailable');
  return r.value;
};
const fromPanel = sender => sender.id === browser.runtime.id && sender.url?.split(/[?#]/)[0] === PANEL;
const fromContent = sender => sender.id === browser.runtime.id && sender.tab?.id !== undefined && sender.frameId === 0 && /^https?:\/\//.test(sender.url ?? '');
async function readContext(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('Invalid context');
  const c = await vault('read', `ctx-${id}`);
  if (!c || c.expiresAt <= Date.now()) throw new Error('Context expired');
  return c;
}
async function panelContext(id, sender) {
  const c = await readContext(id);
  if (!fromPanel(sender) || c.panelTab !== sender.tab?.id || c.panelFrame !== sender.frameId) throw new Error('Panel context mismatch');
  return c;
}
async function api(path, method = 'GET', body, anonymous = false) {
  const token = anonymous ? null : await vault('read', 'token');
  if (!anonymous && !token) return { status: 401, body: JSON.stringify({ error: 'Extension connection required' }), headers: { 'content-type': 'application/json' } };
  const response = await fetch(API_ORIGIN + path, { method, body, redirect: 'error', credentials: 'omit',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const text = await response.text();
  if (response.status === 401 && !anonymous) await vault('delete', 'token');
  return { status: response.status, body: text, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } };
}
let explanationChain = Promise.resolve();
const explanations = new Map();
let contextChain = Promise.resolve();
function exclusive(fn) { const next = contextChain.then(fn); contextChain = next.catch(() => {}); return next; }
browser.runtime.onMessage.addListener((message, sender) => (async () => {
  if (!message || typeof message !== 'object') throw new Error('Invalid message');
  if (message.type === 'selection') {
    if (!fromContent(sender) || !validSelection(message.text)) throw new Error('Invalid selection');
    const id = random(), bind = random();
    const c = { text: message.text, source: sourceDetails(sender.url, message.title), sourceTab: sender.tab.id,
      expiresAt: Date.now() + 86400000, ingestionId: crypto.randomUUID(), jobKey: crypto.randomUUID(), bind };
    await vault('write', `ctx-${id}`, c);
    return { id, bind, url: `${PANEL}?context=${id}` };
  }
  // The source content script transfers a secret directly into its intended iframe.
  // A page-created iframe can know the public context ID, but cannot read that secret.
  if (message.type === 'bind') return exclusive(async () => {
    if (!fromPanel(sender)) throw new Error('Invalid panel');
    const c = await readContext(message.context);
    if (c.sourceTab !== sender.tab?.id || c.bind !== message.bind || c.panelFrame !== undefined) throw new Error('Invalid binding');
    c.panelTab = sender.tab.id; c.panelFrame = sender.frameId; delete c.bind;
    await vault('write', `ctx-${message.context}`, c);
    await browser.tabs.sendMessage(c.sourceTab, { type: 'bound', context: message.context }, { frameId: 0 });
    return { ok: true };
  });
  if (message.type === 'fallback') return exclusive(async () => {
    if (!fromContent(sender)) throw new Error('Invalid source');
    const c = await readContext(message.context);
    if (c.sourceTab !== sender.tab.id || c.bind !== message.bind) throw new Error('Invalid fallback');
    // Create inactive first; publish binding before the page can execute.
    const tab = await browser.tabs.create({ url: 'about:blank', active: false });
    c.panelTab = tab.id; c.panelFrame = 0; delete c.bind;
    await vault('write', `ctx-${message.context}`, c);
    await browser.tabs.update(tab.id, { url: `${PANEL}?context=${message.context}`, active: true }); return { ok: true };
  });
  if (message.type === 'get-context') {
    const c = await panelContext(message.context, sender);
    const { bind, ...safe } = c; return safe;
  }
  // No unbound public extension page is privileged, including pages opened by a website.
  if (message.type === 'status') {
    await panelContext(message.context, sender);
    const c = await vault('read', 'connection');
    return { connected: !!await vault('read', 'token'), pending: c && c.expiresAt > Date.now() ? { code: c.code, expiresAt: c.expiresAt } : null };
  }
  if (message.type === 'connect') {
    await panelContext(message.context, sender);
    const verifier = random(), state = random();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = await api('/api/auth/extension/start', 'POST', JSON.stringify({ challenge, state }), true);
    if (r.status !== 200) throw new Error(`Connection: ${r.status}`);
    const v = JSON.parse(r.body);
    await vault('write', 'connection', { id: v.id, verifier, state, expiresAt: v.expiresAt, code: v.code });
    const url = new URL(v.authorizationUrl);
    if (url.origin !== API_ORIGIN || url.pathname !== '/extension/connect') throw new Error('Invalid authorization origin');
    await browser.tabs.create({ url: url.href });
    return { code: v.code, expiresAt: v.expiresAt };
  }
  if (message.type === 'exchange') {
    await panelContext(message.context, sender);
    const c = await vault('read', 'connection');
    if (!c || c.expiresAt <= Date.now()) throw new Error('Connection expired');
    const r = await api('/api/auth/extension/exchange', 'POST', JSON.stringify({ id: c.id, verifier: c.verifier, state: c.state }), true);
    if (r.status === 202) return { pending: true };
    await vault('delete', 'connection');
    if (r.status !== 200) throw new Error(`Connection: ${r.status}`);
    await vault('write', 'token', JSON.parse(r.body).token); return { connected: true };
  }
  if (message.type === 'disconnect') {
    await panelContext(message.context, sender);
    const r = await api('/api/auth/extension/revoke', 'POST', '{}');
    if (r.status !== 200 && r.status !== 401) throw new Error(`Revoke: ${r.status}`);
    await vault('clear'); return { ok: true };
  }
  if (message.type === 'api') {
    await panelContext(message.context, sender);
    if (!allowedApi(message.method, message.path, message.body)) throw new Error('API capability denied');
    if (message.method === 'POST' && /\/sentences\/[0-9]+\/explanation$/.test(message.path)) {
      const key = message.path;
      if (!explanations.has(key)) {
        const request = explanationChain.then(() => api(message.path, message.method, message.body));
        explanationChain = request.then(() => {}, () => {});
        explanations.set(key, request);
        request.finally(() => explanations.delete(key)).catch(() => {});
      }
      return explanations.get(key);
    }
    return api(message.path, message.method, message.body);
  }
  if (message.type === 'save-operation') return exclusive(async () => {
    const c = await panelContext(message.context, sender);
    if (message.request !== undefined) {
      if (c.request && c.request !== message.request) throw new Error('Frozen operation changed');
      if (!allowedApi('POST', '/api/import/chinese/sessions', message.request)) throw new Error('Invalid operation');
      c.request = message.request;
    }
    if (message.sessionId !== undefined) {
      if (typeof message.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.sessionId)) throw new Error('Invalid session');
      if (c.sessionId && c.sessionId !== message.sessionId) throw new Error('Session changed');
      c.sessionId = message.sessionId; delete c.text; delete c.request; delete c.menu;
    }
    await vault('write', `ctx-${message.context}`, c); return { ok: true };
  });
  if (message.type === 'detach') return exclusive(async () => {
    const c = await panelContext(message.context, sender);
    const tab = await browser.tabs.create({ url: 'about:blank', active: false });
    c.panelTab = tab.id; c.panelFrame = 0;
    await vault('write', `ctx-${message.context}`, c);
    await browser.tabs.update(tab.id, { url: `${PANEL}?context=${message.context}`, active: true });
    await browser.tabs.sendMessage(c.sourceTab, { type: 'dismiss', context: message.context }, { frameId: 0 }).catch(() => {});
    return { ok: true };
  });
  if (message.type === 'close') {
    const c = await panelContext(message.context, sender);
    await browser.tabs.sendMessage(c.sourceTab, { type: 'dismiss', context: message.context }, { frameId: 0 }).catch(() => {});
    return { ok: true };
  }
  throw new Error('Unknown message');
})().catch(error => ({ error: error instanceof Error ? error.message : 'Extension error' })));

// The toolbar opens a background-created tab with an explicit context. Public
// panel.html documents never obtain capabilities merely by being extension URLs.
browser.action.onClicked.addListener(async tab => {
  const id = random();
  const target = await browser.tabs.create({ url: 'about:blank', active: false });
  try {
    await vault('write', `ctx-${id}`, { menu: true, source: {}, sourceTab: tab.id,
      panelTab: target.id, panelFrame: 0, expiresAt: Date.now() + 86400000,
      ingestionId: crypto.randomUUID(), jobKey: crypto.randomUUID() });
  } finally {
    await browser.tabs.update(target.id, { url: `${PANEL}?context=${id}`, active: true });
  }
});
