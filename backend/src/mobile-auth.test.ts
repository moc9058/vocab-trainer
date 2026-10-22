import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { loadAuthConfig, signSession } from './auth-config.js';
import { authenticatedUser, mobileAuthRoutes, type MobileAuthStore, type MobileSession, type MobileTransaction } from './mobile-auth.js';

const digest = (s: string) => createHash('sha256').update(s).digest('base64url');
class MemoryStore implements MobileAuthStore {
  transactions = new Map<string, MobileTransaction>(); sessions = new Map<string, MobileSession>(); count = 0;
  async limit() { return ++this.count <= 100; }
  async start(id: string, data: MobileTransaction) { this.transactions.set(id, data); }
  async consume(id: string, verifier: string) {
    const data = this.transactions.get(id);
    if (!data || data.expiresAt <= Date.now() || data.challenge !== digest(verifier)) return null;
    this.transactions.delete(id); return data;
  }
  async save(token: string, data: MobileSession) { this.sessions.set(token, data); }
  async read(token: string) { const s = this.sessions.get(token); return s && s.expiresAt > Date.now() ? s : null; }
  async revoke(token: string) { this.sessions.delete(token); }
}
test('mobile OAuth validates PKCE, one-time exchange, allowlist, Bearer precedence, expiry and revocation', async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'web-test', GOOGLE_CLIENT_SECRET: 'dummy', OAUTH_REDIRECT_URI: 'https://web.invalid/api/auth/callback', SESSION_SECRET: 'dummy-test-secret', ALLOWED_EMAILS: 'owner@example.test' });
  await loadAuthConfig();
  const store = new MemoryStore(); let calls = 0; let email = 'owner@example.test';
  const app = Fastify(); await app.register(cookie);
  await app.register(mobileAuthRoutes, { prefix: '/api/auth/mobile', store,
    config: () => ({ clientId: 'ios.apps.googleusercontent.com', scheme: 'com.googleusercontent.apps.ios', redirectUri: 'com.googleusercontent.apps.ios:/oauthredirect' }),
    exchangeGoogle: async () => { calls++; return { email }; } });
  const verifier = 'x'.repeat(43); const state = 's'.repeat(43);
  const start = () => app.inject({ method: 'POST', url: '/api/auth/mobile/start', payload: { state, challenge: digest(verifier) } });
  const exchange = (id: string, v = verifier) => app.inject({ method: 'POST', url: '/api/auth/mobile/exchange', payload: { id, verifier: v, code: 'dummy-google-code' } });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/mobile/start', payload: { challenge: 'bad', state } })).statusCode, 400);
    const begin = (await start()).json(); const url = new URL(begin.authorizationUrl);
    assert.equal(url.hostname, 'accounts.google.com'); assert.equal(url.searchParams.get('code_challenge'), digest(verifier));
    assert.equal(url.searchParams.get('state'), state); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('client_secret'), null);
    assert.equal((await exchange(begin.id, 'z'.repeat(43))).statusCode, 401); assert.equal(calls, 0);
    const responses = await Promise.all([exchange(begin.id), exchange(begin.id)]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 401]); assert.equal(calls, 1);
    const token = responses.find(r => r.statusCode === 200)!.json().token;
    const webCookie = { vt_session: signSession({ email }, 'dummy-test-secret') };
    assert.equal((await authenticatedUser({ headers: {}, cookies: webCookie }, store))?.email, email);
    assert.equal(await authenticatedUser({ headers: { authorization: 'Bearer invalid' }, cookies: webCookie }, store), null);
    assert.equal((await authenticatedUser({ headers: { authorization: `Bearer ${token}` }, cookies: {} }, store))?.email, email);
    store.sessions.get(token)!.expiresAt = Date.now() - 1;
    assert.equal(await authenticatedUser({ headers: { authorization: `Bearer ${token}` }, cookies: {} }, store), null);
    const expired = (await start()).json(); store.transactions.get(expired.id)!.expiresAt = Date.now() - 1;
    assert.equal((await exchange(expired.id)).statusCode, 401);
    email = 'other@example.test'; assert.equal((await exchange((await start()).json().id)).statusCode, 403);
    email = 'owner@example.test'; const active = (await exchange((await start()).json().id)).json().token;
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/mobile/logout', headers: { authorization: `Bearer ${active}` } })).statusCode, 200);
    assert.equal(await store.read(active), null);
    store.count = 100; assert.equal((await start()).statusCode, 429);
  } finally { await app.close(); }
});
test('mobile sign-in fails closed when iOS configuration is absent', async () => {
  const app = Fastify(); await app.register(mobileAuthRoutes, { store: new MemoryStore(), config: () => null });
  try { assert.equal((await app.inject({ method: 'POST', url: '/start', payload: {} })).statusCode, 503); }
  finally { await app.close(); }
});
