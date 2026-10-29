import { createHash, randomBytes } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type { FastifyRequest } from 'fastify';
import { getAuthConfig, isEmailAllowed, SESSION_COOKIE, verifySession, type SessionUser } from './auth-config.js';
export const digest = (s: string) => createHash('sha256').update(s).digest('base64url');
export const secret = () => randomBytes(32).toString('base64url');
export interface ExtensionRequest { challenge: string; state: string; code: string; expiresAt: number; user?: SessionUser }
export interface ExtensionSession { user: SessionUser; expiresAt: number; createdAt: number }
export interface ExtensionAuthStore {
  limit(key: string): Promise<boolean>;
  start(id: string, value: ExtensionRequest): Promise<void>;
  request(id: string): Promise<ExtensionRequest | null>;
  approve(id: string, code: string, user: SessionUser): Promise<boolean>;
  exchange(id: string, verifier: string, state: string): Promise<{ token: string; session: ExtensionSession } | 'pending' | null>;
  read(token: string): Promise<ExtensionSession | null>;
  revoke(token: string): Promise<void>;
  list(email: string): Promise<{ id: string; expiresAt: number; createdAt: number }[]>;
  revokeOwned(id: string, email: string): Promise<void>;
}
/** Read-time expiry is authoritative; TTL only reclaims already invalid metadata. */
export class FirestoreExtensionAuthStore implements ExtensionAuthStore {
  constructor(private db = new Firestore({ projectId: process.env.FIRESTORE_PROJECT || undefined,
    databaseId: process.env.FIRESTORE_DATABASE_ID || 'vocab-database', ignoreUndefinedProperties: true })) {}
  async limit(key: string) {
    const ref = this.db.collection('extension_auth_limits').doc(digest(`${Math.floor(Date.now() / 60_000)}:${key}`));
    return this.db.runTransaction(async tx => {
      const count = (await tx.get(ref)).data()?.count ?? 0;
      if (count >= 15) return false;
      tx.set(ref, { count: count + 1, cleanupAt: new Date(Date.now() + 120_000) }); return true;
    });
  }
  async start(id: string, value: ExtensionRequest) {
    for (const collection of ['extension_auth_requests', 'extension_auth_sessions', 'extension_auth_limits']) {
      const expired = await this.db.collection(collection).where('cleanupAt', '<=', new Date()).limit(25).get();
      if (!expired.empty) { const batch = this.db.batch(); expired.docs.forEach(d => batch.delete(d.ref)); await batch.commit(); }
    }
    // A transactionally bounded global pending pool prevents anonymous request floods.
    const quota = this.db.collection('extension_auth_limits').doc('pending');
    const ref = this.db.collection('extension_auth_requests').doc(digest(id));
    await this.db.runTransaction(async tx => {
      const data = (await tx.get(quota)).data();
      const active = ((data?.requests ?? []) as { id: string; expiresAt: number }[]).filter(r => r.expiresAt > Date.now());
      if (active.length >= 100) throw Object.assign(new Error('Too many pending connections'), { statusCode: 429 });
      tx.set(quota, { requests: [...active, { id: digest(id), expiresAt: value.expiresAt }] });
      tx.create(ref, { ...value, cleanupAt: new Date(value.expiresAt) });
    });
  }
  async request(id: string) {
    const v = (await this.db.collection('extension_auth_requests').doc(digest(id)).get()).data() as ExtensionRequest | undefined;
    return v && v.expiresAt > Date.now() ? v : null;
  }
  async approve(id: string, code: string, user: SessionUser) {
    const ref = this.db.collection('extension_auth_requests').doc(digest(id));
    return this.db.runTransaction(async tx => {
      const v = (await tx.get(ref)).data() as ExtensionRequest | undefined;
      if (!v || v.user || v.expiresAt <= Date.now() || v.code !== code) return false;
      tx.update(ref, { user }); return true;
    });
  }
  async exchange(id: string, verifier: string, state: string) {
    const ref = this.db.collection('extension_auth_requests').doc(digest(id));
    return this.db.runTransaction(async tx => {
      const v = (await tx.get(ref)).data() as ExtensionRequest | undefined;
      if (!v || v.expiresAt <= Date.now() || v.challenge !== digest(verifier) || v.state !== state) return null;
      if (!v.user) return 'pending' as const;
      if (!isEmailAllowed(v.user.email)) return null;
      const token = secret(); const session = { user: v.user, createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400_000 };
      tx.delete(ref); tx.create(this.db.collection('extension_auth_sessions').doc(digest(token)), { ...session, cleanupAt: new Date(session.expiresAt) });
      return { token: `ext_${token}`, session };
    });
  }
  async read(token: string) {
    const v = (await this.db.collection('extension_auth_sessions').doc(digest(token.slice(4))).get()).data() as ExtensionSession | undefined;
    return v && v.expiresAt > Date.now() ? v : null;
  }
  async revoke(token: string) { await this.db.collection('extension_auth_sessions').doc(digest(token.slice(4))).delete(); }
  async list(email: string) {
    const snap = await this.db.collection('extension_auth_sessions').where('user.email', '==', email).get();
    return snap.docs.filter(d => d.data().expiresAt > Date.now()).map(d => ({ id: d.id, expiresAt: d.data().expiresAt, createdAt: d.data().createdAt }));
  }
  async revokeOwned(id: string, email: string) {
    const ref = this.db.collection('extension_auth_sessions').doc(id);
    await this.db.runTransaction(async tx => { if ((await tx.get(ref)).data()?.user.email === email) tx.delete(ref); });
  }
}
let store: ExtensionAuthStore | undefined;
export const extensionStore = () => store ??= new FirestoreExtensionAuthStore();
export const extensionToken = (request: Pick<FastifyRequest, 'headers'>) => {
  const h = request.headers.authorization; return h && /^Bearer ext_[A-Za-z0-9_-]{43}$/.test(h) ? h.slice(7) : null;
};
export function cookieUser(request: Pick<FastifyRequest, 'headers' | 'cookies'>): SessionUser | null {
  const cfg = getAuthConfig();
  if (!cfg || request.headers.authorization !== undefined) return null;
  const user = verifySession(request.cookies[SESSION_COOKIE], cfg.sessionSecret);
  return user && isEmailAllowed(user.email) ? user : null;
}
export function sameAppOrigin(request: Pick<FastifyRequest, 'headers'>): boolean {
  const cfg = getAuthConfig();
  return !!cfg && typeof request.headers.origin === 'string' && cfg.redirectUris.some(uri => new URL(uri).origin === request.headers.origin);
}
