if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('An explicit emulator is required; this worker must never run against production');
const { db } = await import('../firestore.js');
const { LibraryOAuth } = await import('./oauth.js');
const { reconcileIntegrationOperations } = await import('./tasks.js');
const { default: Fastify } = await import('fastify');
const app = Fastify({ logger:true });
const oauth = new LibraryOAuth(db,'http://localhost:5173',() => true);
let stopping = false;
process.once('SIGINT',() => { stopping = true; }); process.once('SIGTERM',() => { stopping = true; });
try { while (!stopping) { await reconcileIntegrationOperations(db,oauth,app.log,true); await new Promise(resolve => setTimeout(resolve,3000)); } }
finally { await db.terminate(); await app.close(); }
