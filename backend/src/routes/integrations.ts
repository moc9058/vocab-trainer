import type { FastifyPluginAsync } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { db } from '../firestore.js';
import { getAuthConfig, isEmailAllowed } from '../auth-config.js';
import { cookieUser } from '../extension-auth.js';
import { LibraryOAuth, oauthScopes, digest } from '../integrations/oauth.js';
import { LibraryIntegrationService } from '../integrations/service.js';
import { createIntegrationMcp } from '../integrations/mcp.js';
import { DomainError } from '../integrations/domain.js';
import { integrationJobsConfigured, reconcileIntegrationOperations, runIntegrationOperation, verifyIntegrationWorker } from '../integrations/tasks.js';
const escape = (s: string) => s.replace(/[&<>"']/g,c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
export function integrationPublicPath(method: string, path: string) {
  return path.startsWith('/api/integrations/') || method === 'GET' && ['/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/api/integrations/mcp'].includes(path)
    || method === 'POST' && ['/internal/integration-operations/run','/internal/integration-operations/reconcile'].includes(path);
}
export const integrationRoutes: FastifyPluginAsync = async app => {
  const cfg = getAuthConfig();
  const enabled = process.env.INTEGRATIONS_ENABLED === 'true' && !!cfg;
  const origin = cfg ? new URL(cfg.redirectUris[0]).origin : 'https://unconfigured.invalid';
  const oauth = new LibraryOAuth(db,origin,isEmailAllowed);
  const service = new LibraryIntegrationService(db,oauth,cfg?.sessionSecret ?? '',() => reconcileIntegrationOperations(db,oauth,app.log));
  app.addContentTypeParser('application/x-www-form-urlencoded',{ parseAs:'string',bodyLimit:16384 },(_req,body,done) => {
    const values = new URLSearchParams(body as string); const result: Record<string,string> = {};
    for (const [key,value] of values) { if (key in result) return done(new Error('Duplicate form parameter')); result[key] = value; }
    done(null,result);
  });
  const metadata = { resource: oauth.resource, authorization_servers: [origin], scopes_supported: oauthScopes };
  for (const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/api/integrations/mcp']) app.get(path,async (_req,reply) => enabled ? metadata : reply.code(503).send({ error:'Integration unavailable' }));
  app.get('/.well-known/oauth-authorization-server',async (_req,reply) => enabled ? oauth.metadata() : reply.code(503).send({ error:'Integration unavailable' }));
  app.register(async api => {
    api.addHook('onRequest',async (req,reply) => {
      reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
      if (!enabled) return reply.code(503).send({ error:'Integration unavailable' });
      // MCP calls authenticate below and use the durable worker queue for throughput.
      // Keep request limits on OAuth and connection-management endpoints only.
      const mcp = req.url.split('?')[0] === '/api/integrations/mcp';
      if (mcp) return;
      try { await oauth.limit(`ip:${req.ip}`,60); }
      catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'RATE_LIMITED') throw error;
        return reply.code(429).header('Retry-After','60').send({ error:'rate_limited',retryAfterMs:60000 });
      }
    });
    api.setErrorHandler((error,_req,reply) => {
      const code = error instanceof DomainError ? error.code : 'TEMPORARILY_UNAVAILABLE';
      const status = code === 'RATE_LIMITED' ? 429 : code === 'UNAUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'TEMPORARILY_UNAVAILABLE' ? 503 : 400;
      reply.code(status).send({ error:code.toLowerCase() });
    });
    api.post<{ Body: Record<string,unknown> }>('/oauth/register',{ bodyLimit:16384 },async (req,reply) => {
      await oauth.limit('registration',10);
      return reply.code(201).send(await oauth.register(req.body));
    });
    api.get<{ Querystring: Record<string,unknown> }>('/oauth/authorize',async (req,reply) => {
      reply.header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com https://chat.openai.com; frame-ancestors 'none'; base-uri 'none'");
      // Safari can send Origin: null on form POSTs under no-referrer.
      // Preserve same-origin form provenance while hiding OAuth query data
      // from cross-origin navigation; approve still requires the exact origin.
      reply.header('Referrer-Policy','same-origin');
      const user = cookieUser(req);
      const page = (body: string) => reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vocab Trainer connection</title><body style="font:18px system-ui;max-width:42rem;margin:3rem auto;padding:1rem"><h1>Vocab Trainer ↔ ChatGPT</h1>${body}</body></html>`);
      if (!user) return page(`<p>Sign in / ログイン / 로그인</p><p><a href="/api/auth/login" target="_blank" rel="noopener">Google login</a></p><p>After signing in, return here and reload.<br>로그인 후 이 화면으로 돌아와 새로고침하세요。<br>ログイン後、この画面を再読み込みしてください。</p><a href="${escape(req.url)}">Reload / 再読み込み / 새로고침</a>`);
      const consent = await oauth.authorization(req.query,user.email);
      return page(`<p>${escape(user.email)}</p><p>Allow ChatGPT to read and change your shared Chinese vocabulary and grammar library?<br>중국어 단어·문법 조회 및 변경을 허용하시겠습니까?<br>中国語の単語・文法の参照と変更を許可しますか？</p><p>${consent.scopes.map(escape).join(', ')}</p><form method="post" action="/api/integrations/oauth/approve"><input type="hidden" name="id" value="${consent.id}"><input type="hidden" name="csrf" value="${consent.csrf}"><button>Allow / 許可 / 허용</button></form><p>To cancel, close this page. / 취소하려면 창을 닫으세요。 / キャンセルはこの画面を閉じてください。</p>`);
    });
    api.post<{ Body: {id:string;csrf:string} }>('/oauth/approve',async (req,reply) => {
      const user = cookieUser(req);
      if (!user || req.headers.origin !== origin || typeof req.body.id !== 'string' || typeof req.body.csrf !== 'string') throw new DomainError('FORBIDDEN');
      return reply.redirect(await oauth.approve(req.body.id,req.body.csrf,user.email));
    });
    api.post<{ Body: Record<string,string> }>('/oauth/token',{ bodyLimit:16384 },async req => oauth.exchange(req.body));
    api.post<{ Body: {token?:string} }>('/oauth/revoke',async req => {
      const token = req.body.token;
      if (typeof token === 'string' && token.length < 256) {
        const access = await db.collection(token.startsWith('vti_') ? 'integration_oauth_access' : 'integration_oauth_refresh').doc(digest(token)).get();
        const connectionId = access.data()?.connectionId;
        if (connectionId) await db.collection('integration_connections').doc(connectionId).update({ enabled:false });
      }
      return {};
    });
    api.get('/connections',async req => {
      const user = cookieUser(req); if (!user) throw new DomainError('UNAUTHENTICATED');
      const docs = await db.collection('integration_connections').where('email','==',user.email).get();
      return { connections:docs.docs.map(d => ({ id:d.id,enabled:d.data().enabled,createdAt:d.data().createdAt,expiresAt:d.data().expiresAt })) };
    });
    api.post<{ Body:{id:string} }>('/connections/revoke',async req => {
      const user = cookieUser(req); if (!user || req.headers.origin !== origin || !/^[\w-]{43}$/.test(req.body.id)) throw new DomainError('FORBIDDEN');
      const ref = db.collection('integration_connections').doc(req.body.id);
      await db.runTransaction(async tx => { const data = (await tx.get(ref)).data(); if (data?.email === user.email) tx.update(ref,{ enabled:false }); }); return { ok:true };
    });
    api.post('/mcp',{ bodyLimit:98304 },async (req,reply) => {
      let principal;
      try { principal = await oauth.authenticate(req.headers.authorization); }
      catch (error) { reply.header('WWW-Authenticate',`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/integrations/mcp"`); throw error; }
      if (!integrationJobsConfigured()) return reply.code(503).send({ error:'worker_unavailable' });
      const server = createIntegrationMcp(principal,service);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator:undefined,enableJsonResponse:true });
      await server.connect(transport);
      for (const [key,value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(key,value);
      reply.hijack();
      reply.raw.once('close',() => { void server.close(); });
      try { await transport.handleRequest(req.raw,reply.raw,req.body); }
      catch { if (!reply.raw.headersSent) { reply.raw.writeHead(500,{ 'Content-Type':'application/json' }); reply.raw.end(JSON.stringify({ error:'Protocol failure' })); } }
    });
    for (const method of ['GET','DELETE'] as const) api.route({ method,url:'/mcp',handler:async (_req,reply) => reply.code(405).header('Allow','POST').send({ error:'Stateless transport uses POST' }) });
  },{ prefix:'/api/integrations' });
  app.register(async worker => {
    worker.addHook('onRequest',async (req,reply) => { if (!enabled || !await verifyIntegrationWorker(req)) return reply.code(401).send({ error:'Unauthorized' }); });
    worker.post<{ Body:{id:string} }>('/run',{ schema:{ body:{ type:'object',additionalProperties:false,required:['id'],properties:{ id:{ type:'string',pattern:'^[a-f0-9]{64}$' } } } } },async req => { await runIntegrationOperation(db,oauth,req.body.id,app.log); return { ok:true }; });
    worker.post('/reconcile',async () => ({ dispatched:await reconcileIntegrationOperations(db,oauth,app.log) }));
  },{ prefix:'/internal/integration-operations' });
};
