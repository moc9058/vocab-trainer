import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createIntegrationAuthenticator, readIntegrationAuthConfig } from './integrations/auth.js';

test('integration auth stays disabled unless explicitly configured; malformed configuration fails closed', () => {
  assert.equal(readIntegrationAuthConfig({}), null);
  assert.throws(() => readIntegrationAuthConfig({ INTEGRATIONS_ENABLED: 'true' }));
  assert.throws(() => readIntegrationAuthConfig({ INTEGRATIONS_ENABLED: 'true', INTEGRATION_OAUTH_ISSUER: 'https://issuer.test/',
    INTEGRATION_OAUTH_AUDIENCE: 'library', INTEGRATION_OAUTH_JWKS_URI: 'https://attacker.test/keys', INTEGRATION_MCP_RESOURCE: 'https://app.test/mcp' }));
});
test('signed tokens require audience, scope, mapped subject and live authorization', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  let enabled = true;
  let available = true;
  const config = { issuer: 'https://issuer.test/', audience: 'library', jwksUri: 'https://issuer.test/keys', resource: 'https://app.test/mcp' };
  const authenticate = createIntegrationAuthenticator(config, {
    findConnection: async (_issuer, sub) => { if (!available) throw new Error('storage'); return sub === 'owner' ? { principalId: 'p1', connectionId: 'c1', email: 'owner@test', enabled } : null; },
    isEmailAllowed: async () => true,
  }, async () => publicKey);
  const token = (audience = 'library', subject = 'owner') => new SignJWT({ scope: 'vocab.read' }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(config.issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal((await authenticate(`Bearer ${await token()}`)).id, 'p1');
  await assert.rejects(authenticate(undefined), { status: 401 });
  await assert.rejects(authenticate(`Bearer ${await token('other')}`), { status: 401 });
  await assert.rejects(authenticate(`Bearer ${await token('library', 'unknown')}`), { status: 403 });
  enabled = false;
  await assert.rejects(authenticate(`Bearer ${await token()}`), { status: 403 });
  available = false;
  await assert.rejects(authenticate(`Bearer ${await token()}`), { status: 503 });
});
