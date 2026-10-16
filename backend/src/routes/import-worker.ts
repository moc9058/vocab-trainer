import type { FastifyPluginAsync } from 'fastify';
import { reconcileAnalysisJobs, runAnalysisTask, type ImportTaskPayload } from '../import-job-store.js';
import { verifyImportWorker } from '../import-task-dispatch.js';
import { ImportCheckpointError } from '../import-parts.js';

export const importWorkerRoutes: FastifyPluginAsync = async app => {
  app.addHook('onRequest', async (request, reply) => {
    if (!await verifyImportWorker(request)) return reply.code(401).send({ error: 'Unauthorized' });
  });
  app.post<{ Body: ImportTaskPayload }>('/run', { schema: { body: { type: 'object', additionalProperties: false,
    required: ['jobId', 'generation', 'batch', 'sequence'], properties: { jobId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' }, generation: { type: 'integer', minimum: 1 }, batch: { type: 'integer', minimum: 0 }, sequence: { type: 'integer', minimum: 0 } } } } }, async (request, reply) => {
    try { await runAnalysisTask(request.body); return { ok: true }; }
    catch (err) { if (err instanceof ImportCheckpointError) return reply.code(err.statusCode).send({ message: err.message }); throw err; }
  });
  app.post('/reconcile', async () => ({ checked: await reconcileAnalysisJobs() }));
};
