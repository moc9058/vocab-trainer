import type { FastifyPluginAsync } from 'fastify';
import { getImportSession } from '../firestore.js';
import { startAnalysisJob, getAnalysisJob, changeAnalysisJob } from '../import-job-store.js';
import { jobSummary } from '../import-jobs.js';
import { ImportCheckpointError } from '../import-parts.js';

const importJobRoutes: FastifyPluginAsync = async app => {
  const diagnosticTimes = new Map<string, number>();
  let diagnosticWindow = 0, diagnosticCount = 0;
  type Params = { language: string; sessionId: string };
  const base = '/:language/sessions/:sessionId/analysis-job';
  const bodySchema = { type: 'object', required: ['idempotencyKey'], additionalProperties: false,
    properties: { idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 }, analysisRevision: { type: 'integer', minimum: 0 } } };
  app.get<{ Params: Params }>(base, async (request, reply) => {
    const s = await getImportSession(request.params.sessionId);
    if (!s || s.language !== request.params.language) return reply.notFound('Import session not found');
    const job = await getAnalysisJob(s.id);
    reply.header('Cache-Control', 'no-store');
    return job ? jobSummary(job) : reply.code(404).send({ code: 'IMPORT_JOB_NOT_FOUND', message: 'Analysis job not found' });
  });
  for (const action of ['start', 'resume', 'pause'] as const) {
    app.post<{ Params: Params; Body: { idempotencyKey: string; analysisRevision?: number } }>(action === 'start' ? base : `${base}/${action}`,
      { schema: { body: bodySchema } }, async (request, reply) => {
        try {
          const { language, sessionId } = request.params;
          const job = action === 'start' ? await startAnalysisJob(language, sessionId, request.body.idempotencyKey, request.body.analysisRevision)
            : await changeAnalysisJob(language, sessionId, action, request.body.idempotencyKey);
          return reply.code(202).send(jobSummary(job));
        } catch (err) {
          if (err instanceof ImportCheckpointError) return reply.code(err.statusCode).send({ code: 'IMPORT_JOB_REQUEST_FAILED', message: err.message });
          throw err;
        }
      });
  }
  app.post<{ Body: { jobId: string; phase: string; elapsedMs: number; online: boolean; visibility: string; errorName: string } }>('/analysis-diagnostics', {
    bodyLimit: 2048, schema: { body: { type: 'object', additionalProperties: false, required: ['jobId', 'phase', 'elapsedMs', 'online', 'visibility', 'errorName'],
      properties: { jobId: { type: 'string', maxLength: 100 }, phase: { type: 'string', enum: ['start', 'poll', 'session'] }, elapsedMs: { type: 'number', minimum: 0 }, online: { type: 'boolean' }, visibility: { type: 'string', maxLength: 20 }, errorName: { type: 'string', maxLength: 40 } } } },
  }, async (request, reply) => {
    const now = Date.now();
    if (now - diagnosticWindow > 60_000) { diagnosticWindow = now; diagnosticCount = 0; diagnosticTimes.clear(); }
    if (diagnosticCount < 20 && !diagnosticTimes.has(request.body.jobId)) {
      diagnosticCount++; diagnosticTimes.set(request.body.jobId, now);
      request.log.warn({ ...request.body, requestId: request.id }, 'Import browser transport diagnostic');
    }
    return reply.code(204).send();
  });
};
export default importJobRoutes;
