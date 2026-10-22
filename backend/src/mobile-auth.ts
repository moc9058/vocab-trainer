import { createHash, randomBytes } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getAuthConfig, isEmailAllowed, SESSION_COOKIE, SESSION_MAX_AGE_SEC, verifySession, type SessionUser } from './auth-config.js';

const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');
export interface MobileTransaction { challenge: string; state: string; expiresAt: number }
export interface MobileSession { user: SessionUser; expiresAt: number }
export interface MobileAuthStore {
  limit(key: string): Promise<boolean>;
  start(id: string, tx: MobileTransaction): Promise<void>;
  consume(id: string, verifier: string): Promise<MobileTransaction | null>;
  save(token: string, session: MobileSession): Promise<void>;
  read(token: string): Promise<MobileSession | null>;
  revoke(token: string): Promise<void>;
}

/** Separate metadata collections; no vocabulary, progress or quiz writes. */
export class FirestoreMobileAuthStore implements MobileAuthStore {
  constructor(private readonly db = new Firestore({ projectId: process.env.FIRESTORE_PROJECT || undefined,
    databaseId: process.env.FIRESTORE_DATABASE_ID || 'vocab-database', ignoreUndefinedProperties: true })) {}
  async limit(key: string) {
    const ref = this.db.collection('mobile_auth_limits').doc(hash(`${Math.floor(Date.now() / 60_000)}:${key}`));
    return this.db.runTransaction(async tx => {
      const count = (await tx.get(ref)).data()?.count ?? 0;
      if (count >= 20) return false;
      tx.set(ref, { count: count + 1, expiresAt: new Date(Date.now() + 120_000) });
      return true;
    });
  }
  async start(id: string, data: MobileTransaction) {
    await this.db.collection('mobile_auth_transactions').doc(hash(id)).create({ ...data, cleanupAt: new Date(data.expiresAt) });
  }
  async consume(id: string, verifier: string) {
    const ref = this.db.collection('mobile_auth_transactions').doc(hash(id));
    return this.db.runTransaction(async tx => {
      const doc = await tx.get(ref); const value = doc.data() as MobileTransaction | undefined;
      if (!value || value.expiresAt <= Date.now() || value.challenge !== hash(verifier)) return null;
      tx.delete(ref); // One claimant, across all Cloud Run instances. Failure requires a new login.
      return value;
    });
  }
  async save(token: string, session: MobileSession) {
    await this.db.collection('mobile_auth_sessions').doc(hash(token)).create({ ...session, cleanupAt: new Date(session.expiresAt) });
  }
  async read(token: string) {
    const data = (await this.db.collection('mobile_auth_sessions').doc(hash(token)).get()).data() as MobileSession | undefined;
    return data && data.expiresAt > Date.now() ? data : null;
  }
  async revoke(token: string) { await this.db.collection('mobile_auth_sessions').doc(hash(token)).delete(); }
}
let defaultStore: MobileAuthStore | undefined;
export const mobileStore = () => defaultStore ??= new FirestoreMobileAuthStore();
export function bearer(request: Pick<FastifyRequest, 'headers'>): string | null {
  const value = request.headers.authorization;
  return value && /^Bearer [A-Za-z0-9_-]{43}$/.test(value) ? value.slice(7) : null;
}
export async function authenticatedUser(request: Pick<FastifyRequest, 'headers' | 'cookies'>, store = mobileStore()): Promise<SessionUser | null> {
  const cfg = getAuthConfig();
  if (!cfg) return null;
  if (request.headers.authorization !== undefined) {
    const token = bearer(request); const session = token ? await store.read(token) : null;
    return session && isEmailAllowed(session.user.email) ? session.user : null;
  }
  const user = verifySession(request.cookies[SESSION_COOKIE], cfg.sessionSecret);
  return user && isEmailAllowed(user.email) ? user : null;
}
export function iosOAuthConfig() {
  const clientId = process.env.MOBILE_GOOGLE_CLIENT_ID?.trim();
  if (!clientId || !/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId)) return null;
  const scheme = clientId.split('.').reverse().join('.');
  return { clientId, scheme, redirectUri: `${scheme}:/oauthredirect` };
}
export interface MobileAuthOptions {
  store?: MobileAuthStore;
  config?: () => ReturnType<typeof iosOAuthConfig>;
  exchangeGoogle?: (code: string, verifier: string, config: NonNullable<ReturnType<typeof iosOAuthConfig>>) => Promise<SessionUser>;
}
async function exchangeGoogle(code: string, verifier: string, cfg: NonNullable<ReturnType<typeof iosOAuthConfig>>): Promise<SessionUser> {
  // Public iOS client: no Web client secret, service account or server API key in the app.
  const oauth = new OAuth2Client(cfg.clientId);
  const { tokens } = await oauth.getToken({ code, client_id: cfg.clientId, redirect_uri: cfg.redirectUri, codeVerifier: verifier });
  if (!tokens.id_token) throw new Error('No ID token');
  const payload = (await oauth.verifyIdToken({ idToken: tokens.id_token, audience: cfg.clientId })).getPayload();
  if (!payload?.email || !payload.email_verified) throw new Error('Invalid identity');
  return { email: payload.email, ...(payload.name ? { name: payload.name } : {}), ...(payload.picture ? { picture: payload.picture } : {}) };
}
const secretString = { type: 'string', minLength: 1, maxLength: 2048 };
export const mobileAuthRoutes: FastifyPluginAsync<MobileAuthOptions> = async (app, options) => {
  const store = options.store ?? mobileStore();
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!getAuthConfig() || !(options.config ?? iosOAuthConfig)()) return reply.code(503).send({ error: 'Mobile sign-in is not configured' });
    if (!await store.limit(req.ip)) return reply.code(429).send({ error: 'Try again later' });
  });
  app.post<{ Body: { challenge: string; state: string } }>('/start', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['challenge', 'state'], properties: {
      challenge: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, state: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    },
  } } }, async (req) => {
    const cfg = (options.config ?? iosOAuthConfig)()!;
    const id = random();
    await store.start(id, { ...req.body, expiresAt: Date.now() + 600_000 });
    const params = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
      response_type: 'code', scope: 'openid email profile', state: req.body.state,
      code_challenge: req.body.challenge, code_challenge_method: 'S256', prompt: 'select_account' });
    return { id, authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, callbackScheme: cfg.scheme };
  });
  app.post<{ Body: { id: string; code: string; verifier: string } }>('/exchange', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['id', 'code', 'verifier'], properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, code: secretString,
      verifier: { type: 'string', pattern: '^[A-Za-z0-9_-]{43,128}$' },
    },
  } } }, async (req, reply) => {
    if (!await store.consume(req.body.id, req.body.verifier)) return reply.code(401).send({ error: 'Expired or invalid sign-in' });
    let user: SessionUser;
    try { user = await (options.exchangeGoogle ?? exchangeGoogle)(req.body.code, req.body.verifier, (options.config ?? iosOAuthConfig)()!); }
    catch { return reply.code(401).send({ error: 'Sign-in failed; start again' }); }
    if (!isEmailAllowed(user.email)) return reply.code(403).send({ error: 'Account is not authorized' });
    const token = random(); const expiresAt = Date.now() + SESSION_MAX_AGE_SEC * 1000;
    await store.save(token, { user, expiresAt });
    return { token, expiresAt, user };
  });
  app.post('/logout', async (req) => {
    const token = bearer(req); if (token) await store.revoke(token);
    return { ok: true };
  });
};
