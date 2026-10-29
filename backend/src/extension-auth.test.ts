import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import routes from './routes/extension-auth.js';
import { digest, secret, cookieUser, sameAppOrigin, type ExtensionAuthStore, type ExtensionRequest, type ExtensionSession } from './extension-auth.js';
import { loadAuthConfig, signSession, SESSION_COOKIE } from './auth-config.js';
Object.assign(process.env, { GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test-secret', OAUTH_REDIRECT_URI: 'https://app.example/api/auth/callback', SESSION_SECRET: 'test-only-32-character-session-secret', ALLOWED_EMAILS: 'owner@example.test' });
await loadAuthConfig();
class MemoryStore implements ExtensionAuthStore {
  requests = new Map<string, ExtensionRequest>(); sessions = new Map<string, ExtensionSession>(); available = true;
  async limit() { if (!this.available) throw new Error('storage unavailable'); return true; }
  async start(id: string, value: ExtensionRequest) { this.requests.set(id, value); }
  async request(id: string) { const r = this.requests.get(id); return r && r.expiresAt > Date.now() ? r : null; }
  async approve(id: string, code: string, user: ExtensionSession['user']) {
    const r = await this.request(id); if (!r || r.user || r.code !== code) return false; r.user = user; return true;
  }
  async exchange(id: string, verifier: string, state: string) {
    const r = this.requests.get(id);
    if (!r || r.expiresAt <= Date.now() || r.challenge !== digest(verifier) || r.state !== state) return null;
    if (!r.user) return 'pending' as const;
    this.requests.delete(id);
    const token = `ext_${secret()}`, session = { user: r.user, expiresAt: Date.now() + 1000, createdAt: Date.now() };
    this.sessions.set(token, session); return { token, session };
  }
  async read(token: string) { return this.sessions.get(token) ?? null; }
  async revoke(token: string) { this.sessions.delete(token); }
  async list() { return []; }
  async revokeOwned() {}
}
test('extension approval requires cookie identity, CSRF origin, matching code, PKCE and one claim', async () => {
  const store = new MemoryStore(), app = Fastify(); await app.register(cookie); await app.register(routes, { prefix: '/api/auth/extension', store });
  const verifier = secret(), state = secret();
  const start = await app.inject({ method: 'POST', url: '/api/auth/extension/start', payload: { challenge: digest(verifier), state } });
  assert.equal(start.statusCode, 200); const { id, code, authorizationUrl } = start.json();
  assert.equal(new URL(authorizationUrl).pathname, '/extension/connect');
  const exchange = (v = verifier) => app.inject({ method: 'POST', url: '/api/auth/extension/exchange', payload: { id, verifier: v, state } });
  assert.equal((await exchange()).statusCode, 202);
  assert.equal((await exchange(secret())).statusCode, 401);
  const cookies = { [SESSION_COOKIE]: signSession({ email: 'owner@example.test' }, process.env.SESSION_SECRET!) };
  const approve = (headers = {}, c = cookies, value = code) => app.inject({ method: 'POST', url: '/api/auth/extension/approve', headers, cookies: c, payload: { id, code: value } });
  assert.equal((await approve({}, {})).statusCode, 401);
  assert.equal((await approve()).statusCode, 403);
  assert.equal((await approve({ origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await approve({ origin: 'https://app.example' }, cookies, 'WRONG123')).statusCode, 410);
  const view = await app.inject({ url: `/api/auth/extension/request/${id}`, cookies });
  assert.deepEqual(Object.keys(view.json()).sort(), ['approved', 'code', 'expiresAt']);
  assert.equal((await approve({ origin: 'https://app.example' })).statusCode, 200);
  const results = await Promise.all([exchange(), exchange()]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 401]);
  const token = results.find(r => r.statusCode === 200)!.json().token;
  assert.match(token, /^ext_[A-Za-z0-9_-]{43}$/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/extension/revoke', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
  assert.equal(await store.read(token), null);
  const expired = secret(); await store.start(expired, { challenge: digest(verifier), state, code, expiresAt: 1 });
  assert.equal((await app.inject({ url: `/api/auth/extension/request/${expired}`, cookies })).statusCode, 410);
  store.available = false;
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/extension/start', payload: { challenge: digest(verifier), state } })).statusCode, 503);
  await app.close();
});
test('bearer cannot stand in for approval cookie; invalid origin fails closed', () => {
  assert.equal(cookieUser({ headers: { authorization: 'Bearer invalid' }, cookies: { [SESSION_COOKIE]: signSession({ email: 'owner@example.test' }, process.env.SESSION_SECRET!) } }), null);
  assert.equal(sameAppOrigin({ headers: { origin: 'null' } }), false);
});
