import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Firestore } from '@google-cloud/firestore';
import type { IntegrationPrincipal } from './mcp.js';
import { DomainError } from './domain.js';
export const oauthScopes = ['vocab.read','vocab.write','vocab.delete','grammar.read','grammar.write','grammar.delete','groups.read','groups.write'];
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
export const secret = () => randomBytes(32).toString('base64url');
const equal = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a,b); };
export class LibraryOAuth {
  constructor(readonly db: Firestore, readonly origin: string, readonly allowed: (email: string) => boolean) {}
  get resource() { return `${this.origin}/api/integrations/mcp`; }
  metadata() { return { issuer: this.origin, authorization_endpoint: `${this.origin}/api/integrations/oauth/authorize`,
    token_endpoint: `${this.origin}/api/integrations/oauth/token`, registration_endpoint: `${this.origin}/api/integrations/oauth/register`,
    revocation_endpoint: `${this.origin}/api/integrations/oauth/revoke`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code','refresh_token'], token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], scopes_supported: oauthScopes }; }
  async limit(key: string, max = 30) {
    const ref = this.db.collection('integration_limits').doc(digest(`${key}:${Math.floor(Date.now()/60000)}`));
    await this.db.runTransaction(async tx => { const count = (await tx.get(ref)).data()?.count ?? 0;
      if (count >= max) throw new DomainError('RATE_LIMITED'); tx.set(ref,{ count: count+1, cleanupAt: new Date(Date.now()+120000) }); });
  }
  async register(input: Record<string,unknown>) {
    const redirects = input.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 5 || input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') throw new DomainError('INVALID_CLIENT');
    for (const uri of redirects) {
      if (typeof uri !== 'string' || uri.length > 2000) throw new DomainError('INVALID_CLIENT');
      const u = new URL(uri);
      if (!['https://chatgpt.com','https://chat.openai.com'].includes(u.origin) || u.hash || u.username || u.password) throw new DomainError('INVALID_CLIENT');
    }
    const id = secret();
    await this.db.runTransaction(async tx => {
      const pool = this.db.collection('integration_limits').doc('registered-clients');
      const clients = ((await tx.get(pool)).data()?.clients ?? []).filter((c: {expiresAt:number}) => c.expiresAt > Date.now());
      if (clients.length >= 100) throw new DomainError('RATE_LIMITED');
      const expiresAt = Date.now()+90*86400000;
      tx.set(pool,{ clients:[...clients,{id,expiresAt}] });
      tx.create(this.db.collection('integration_oauth_clients').doc(id),{ redirects,createdAt:Date.now(),expiresAt,cleanupAt:new Date(expiresAt) });
    });
    return { client_id: id, redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'] };
  }
  async authorization(query: Record<string,unknown>, email: string) {
    const client = typeof query.client_id === 'string' && /^[\w-]{43}$/.test(query.client_id) ? (await this.db.collection('integration_oauth_clients').doc(query.client_id).get()).data() : undefined;
    if (!client || client.expiresAt <= Date.now() || !client.redirects.includes(query.redirect_uri) || query.response_type !== 'code'
      || query.resource !== this.resource || query.code_challenge_method !== 'S256' || typeof query.code_challenge !== 'string' || !/^[\w-]{43}$/.test(query.code_challenge)
      || typeof query.state !== 'string' || !query.state || query.state.length > 2000 || typeof query.scope !== 'string') throw new DomainError('INVALID_AUTHORIZATION_REQUEST');
    const scopes = query.scope.split(/\s+/).filter(Boolean);
    if (!scopes.length || scopes.some(scope => !oauthScopes.includes(scope))) throw new DomainError('INVALID_SCOPE');
    const id = secret(), csrf = secret();
    const request = Object.fromEntries(['client_id','redirect_uri','response_type','resource','scope','state','code_challenge','code_challenge_method'].map(key => [key,query[key]]));
    await this.db.collection('integration_oauth_consents').doc(digest(id)).create({ query: request, email, csrf: digest(csrf), scopes,
      expiresAt: Date.now()+600000, cleanupAt: new Date(Date.now()+600000) });
    return { id, csrf, scopes };
  }
  async approve(id: string, csrf: string, email: string) {
    const ref = this.db.collection('integration_oauth_consents').doc(digest(id));
    const code = secret();
    return this.db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      if (!data || data.email !== email || !this.allowed(email) || data.expiresAt <= Date.now() || !equal(data.csrf,digest(csrf))) throw new DomainError('INVALID_CONSENT');
      tx.delete(ref);
      tx.create(this.db.collection('integration_oauth_codes').doc(digest(code)), { ...data.query, email, scopes: data.scopes,
        expiresAt: Date.now()+120000, cleanupAt: new Date(Date.now()+120000) });
      const redirect = new URL(data.query.redirect_uri); redirect.searchParams.set('code',code); redirect.searchParams.set('state',data.query.state);
      return redirect.href;
    });
  }
  async exchange(input: Record<string,string>) {
    const refresh = input.grant_type === 'refresh_token';
    if (!refresh && input.grant_type !== 'authorization_code') throw new DomainError('UNSUPPORTED_GRANT_TYPE');
    const raw = refresh ? input.refresh_token : input.code;
    if (!raw || !/^[\w-]{43}$/.test(raw) || !input.client_id || !/^[\w-]{43}$/.test(input.client_id)) throw new DomainError('INVALID_GRANT');
    const ref = this.db.collection(refresh ? 'integration_oauth_refresh' : 'integration_oauth_codes').doc(digest(raw));
    const access = `vti_${secret()}`, nextRefresh = secret(), connectionId = secret();
    const now = Date.now();
    const result = await this.db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      if (!data || data.expiresAt <= now || data.client_id !== input.client_id || input.resource !== this.resource || !this.allowed(data.email)) throw new DomainError('INVALID_GRANT');
      const client = (await tx.get(this.db.collection('integration_oauth_clients').doc(input.client_id))).data();
      if (!client || client.expiresAt <= now) throw new DomainError('INVALID_CLIENT');
      const connId = refresh ? data.connectionId : connectionId;
      const connRef = this.db.collection('integration_connections').doc(connId);
      const connection = refresh ? (await tx.get(connRef)).data() : null;
      if (refresh && (!connection?.enabled || connection.expiresAt <= now)) throw new DomainError('INVALID_GRANT');
      if (refresh && data.used) { tx.update(connRef,{ enabled: false }); return null; }
      if (!refresh && (input.redirect_uri !== data.redirect_uri || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier ?? '') || !equal(digest(input.code_verifier),data.code_challenge))) throw new DomainError('INVALID_GRANT');
      if (refresh) tx.update(ref,{ used: true }); else tx.delete(ref);
      if (!refresh) tx.create(connRef,{ principalId: digest(`owner:${data.email.toLowerCase()}`), email: data.email, scopes: data.scopes, enabled: true, createdAt: now, expiresAt: now+90*86400000 });
      tx.create(this.db.collection('integration_oauth_access').doc(digest(access)), { connectionId: connId, expiresAt: now+3600000, cleanupAt: new Date(now+3600000) });
      tx.create(this.db.collection('integration_oauth_refresh').doc(digest(nextRefresh)), { connectionId: connId, client_id: input.client_id, email: data.email, scopes: data.scopes, used: false,
        expiresAt: now+30*86400000, cleanupAt: new Date(now+30*86400000) });
      return { access_token: access, refresh_token: nextRefresh, token_type: 'Bearer', expires_in: 3600, scope: data.scopes.join(' ') };
    });
    if (!result) throw new DomainError('INVALID_GRANT');
    return result;
  }
  async authenticate(header?: string): Promise<IntegrationPrincipal> {
    if (!header || !/^Bearer vti_[\w-]{43}$/.test(header)) throw new DomainError('UNAUTHENTICATED');
    const token = (await this.db.collection('integration_oauth_access').doc(digest(header.slice(7))).get()).data();
    if (!token || token.expiresAt <= Date.now()) throw new DomainError('UNAUTHENTICATED');
    const principal = await this.principal(token.connectionId);
    if (!principal) throw new DomainError('FORBIDDEN'); return principal;
  }
  async principal(connectionId: string): Promise<IntegrationPrincipal | null> {
    if (!/^[\w-]{43}$/.test(connectionId)) return null;
    const conn = (await this.db.collection('integration_connections').doc(connectionId).get()).data();
    return conn?.enabled && conn.expiresAt > Date.now() && this.allowed(conn.email)
      ? { id: conn.principalId, connectionId, scopes: conn.scopes } : null;
  }
}
