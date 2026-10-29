import type { FastifyPluginAsync } from 'fastify';
import { getAuthConfig } from '../auth-config.js';
import { cookieUser, sameAppOrigin, extensionStore, extensionToken, secret, type ExtensionAuthStore } from '../extension-auth.js';
const idSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const body = (properties: Record<string, unknown>) => ({ body: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } });
const routes: FastifyPluginAsync<{ store?: ExtensionAuthStore }> = async (app, options) => {
  const store = options.store ?? extensionStore();
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!getAuthConfig()) return reply.code(503).send({ error: 'Extension authentication unavailable' });
    try { if (!await store.limit(req.ip)) return reply.code(429).send({ error: 'Try again later' }); }
    catch { return reply.code(503).send({ error: 'Authentication storage unavailable' }); }
  });
  app.post<{ Body: { challenge: string; state: string } }>('/start', { schema: body({ challenge: idSchema, state: idSchema }) }, async req => {
    const id = secret(), code = secret().slice(0, 8).toUpperCase(), expiresAt = Date.now() + 600_000;
    await store.start(id, { ...req.body, code, expiresAt });
    return { id, code, expiresAt, authorizationUrl: `${new URL(getAuthConfig()!.redirectUris[0]).origin}/extension/connect?id=${id}` };
  });
  app.get<{ Params: { id: string } }>('/request/:id', { schema: { params: { type: 'object', properties: { id: idSchema }, required: ['id'] } } }, async (req, reply) => {
    if (!cookieUser(req)) return reply.code(401).send({ error: 'Sign in required' });
    const v = await store.request(req.params.id);
    return v ? { code: v.code, expiresAt: v.expiresAt, approved: !!v.user } : reply.code(410).send({ error: 'Connection expired' });
  });
  app.post<{ Body: { id: string; code: string } }>('/approve', { schema: body({ id: idSchema, code: { type: 'string', pattern: '^[A-Z0-9_-]{8}$' } }) }, async (req, reply) => {
    const user = cookieUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (!sameAppOrigin(req)) return reply.code(403).send({ error: 'Same origin required' });
    return await store.approve(req.body.id, req.body.code, user) ? { ok: true } : reply.code(410).send({ error: 'Connection expired or already approved' });
  });
  app.post<{ Body: { id: string; verifier: string; state: string } }>('/exchange', { schema: body({ id: idSchema, verifier: { type: 'string', pattern: '^[A-Za-z0-9_-]{43,128}$' }, state: idSchema }) }, async (req, reply) => {
    const v = await store.exchange(req.body.id, req.body.verifier, req.body.state);
    if (!v) return reply.code(401).send({ error: 'Invalid or expired connection; start again' });
    if (v === 'pending') return reply.code(202).send({ pending: true });
    return { token: v.token, expiresAt: v.session.expiresAt, user: v.session.user };
  });
  app.post('/revoke', async (req, reply) => {
    const token = extensionToken(req);
    if (!token) return reply.code(401).send({ error: 'Extension credential required' });
    await store.revoke(token); return { ok: true };
  });
  app.get('/connections', async (req, reply) => {
    const user = cookieUser(req);
    return user ? { connections: await store.list(user.email) } : reply.code(401).send({ error: 'Sign in required' });
  });
  app.post<{ Body: { id: string } }>('/connections/revoke', { schema: body({ id: idSchema }) }, async (req, reply) => {
    const user = cookieUser(req);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (!sameAppOrigin(req)) return reply.code(403).send({ error: 'Same origin required' });
    await store.revokeOwned(req.body.id, user.email); return { ok: true };
  });
};
export default routes;
