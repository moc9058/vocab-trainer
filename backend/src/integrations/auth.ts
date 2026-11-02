import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { IntegrationPrincipal } from './mcp.js';

export interface IntegrationAuthConfig { issuer: string; audience: string; jwksUri: string; resource: string }
export interface IntegrationConnection { principalId: string; connectionId: string; email: string; enabled: boolean }
export interface IntegrationIdentityStore {
  /** Lookup must bind the verified issuer+subject, never an email supplied by the caller. */
  findConnection(issuer: string, subject: string): Promise<IntegrationConnection | null>;
  isEmailAllowed(email: string): Promise<boolean>;
}
export class IntegrationAuthError extends Error {
  constructor(readonly status: 401 | 403 | 503, readonly code: string) { super(code); }
}
function httpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Expected canonical HTTPS URL');
  return url.href;
}
export function readIntegrationAuthConfig(env: NodeJS.ProcessEnv = process.env): IntegrationAuthConfig | null {
  if (env.INTEGRATIONS_ENABLED !== 'true') return null;
  const issuer = env.INTEGRATION_OAUTH_ISSUER;
  const audience = env.INTEGRATION_OAUTH_AUDIENCE;
  const jwksUri = env.INTEGRATION_OAUTH_JWKS_URI;
  const resource = env.INTEGRATION_MCP_RESOURCE;
  if (!issuer || !audience || !jwksUri || !resource) throw new IntegrationAuthError(503, 'AUTH_NOT_CONFIGURED');
  try {
    httpsUrl(issuer); httpsUrl(jwksUri); httpsUrl(resource);
    // Pin keys to the configured provider; never follow a token-supplied jku URL.
    if (new URL(issuer).origin !== new URL(jwksUri).origin) throw new Error('JWKS origin mismatch');
    return { issuer, audience, jwksUri, resource };
  } catch { throw new IntegrationAuthError(503, 'AUTH_NOT_CONFIGURED'); }
}
export function createIntegrationAuthenticator(config: IntegrationAuthConfig, store: IntegrationIdentityStore,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUri))) {
  return async (authorization: string | undefined): Promise<IntegrationPrincipal> => {
    if (!authorization || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) throw new IntegrationAuthError(401, 'UNAUTHENTICATED');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(authorization.slice(7), keys, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
      if (!payload.sub || typeof payload.scope !== 'string') throw new Error('Missing subject/scopes');
    } catch { throw new IntegrationAuthError(401, 'UNAUTHENTICATED'); }
    try {
      const connection = await store.findConnection(config.issuer, payload.sub!);
      if (!connection?.enabled || !await store.isEmailAllowed(connection.email)) throw new IntegrationAuthError(403, 'FORBIDDEN');
      return { id: connection.principalId, connectionId: connection.connectionId, scopes: (payload.scope as string).split(/\s+/).filter(Boolean) };
    } catch (error) {
      if (error instanceof IntegrationAuthError) throw error;
      throw new IntegrationAuthError(503, 'AUTH_UNAVAILABLE');
    }
  };
}
export function protectedResourceMetadata(config: IntegrationAuthConfig) {
  return { resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: ['vocab.read', 'vocab.write', 'vocab.delete', 'grammar.read', 'grammar.write', 'grammar.delete', 'groups.read', 'groups.write'] };
}
