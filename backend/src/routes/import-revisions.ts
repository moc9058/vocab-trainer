import type { FastifyPluginAsync } from 'fastify';
import { actOnRevision, convertWord, getRevision, listRevisions, startRevision } from '../import-revision-store.js';
import { ImportCheckpointError } from '../import-parts.js';
import type { ImportConversionInput, ImportRevisionRequest } from '../types.js';

const text = (maxLength: number) => ({ type: 'string', maxLength });
const conversion = { type: 'object', additionalProperties: false, required: ['itemId', 'start', 'end', 'term', 'meaning', 'transliteration', 'explanationLanguage', 'mode'], properties: {
  itemId: text(200), start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, term: { ...text(200), minLength: 1 }, meaning: text(4000), transliteration: text(1000), explanationLanguage: { type: 'string', enum: ['ja', 'en', 'ko', 'zh'] }, mode: { type: 'string', enum: ['replace', 'add'] } } };
const routes: FastifyPluginAsync = async app => {
  type Params = { language: string; sessionId: string; revisionId: string };
  const base = '/:language/sessions/:sessionId';
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ImportCheckpointError) return reply.code(err.statusCode).send({ message: err.message });
    return reply.send(err);
  });
  app.get<{ Params: Params }>(`${base}/revisions`, async (r, reply) => { reply.header('Cache-Control', 'no-store'); return { revisions: await listRevisions(r.params.language, r.params.sessionId) }; });
  app.get<{ Params: Params }>(`${base}/revisions/:revisionId`, async (r, reply) => { reply.header('Cache-Control', 'no-store'); return getRevision(r.params.language, r.params.sessionId, r.params.revisionId); });
  app.post<{ Params: Params; Body: ImportRevisionRequest }>(`${base}/revisions`, { schema: { body: { type: 'object', additionalProperties: false,
    required: ['kind', 'sentenceIndices', 'update', 'instruction', 'explanationLanguage', 'expectedRevision', 'idempotencyKey'], properties: {
      kind: { type: 'string', enum: ['regenerate', 'word-assist'] }, sentenceIndices: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer', minimum: 0 } },
      update: { type: 'string', enum: ['explanation', 'grammar', 'both'] }, instruction: text(2000), explanationLanguage: { type: 'string', enum: ['ja', 'en', 'ko', 'zh'] },
      expectedRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { ...text(200), minLength: 1 }, conversion } } } }, async (r, reply) => reply.code(202).send(await startRevision(r.params.language, r.params.sessionId, r.body)));
  app.post<{ Params: Params; Body: { conversion: ImportConversionInput; expectedRevision: number; idempotencyKey: string } }>(`${base}/candidate-conversions`, { schema: { body: { type: 'object', additionalProperties: false, required: ['conversion', 'expectedRevision', 'idempotencyKey'], properties: { conversion, expectedRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { ...text(200), minLength: 1 } } } } }, async r => convertWord(r.params.language, r.params.sessionId, r.body.conversion, r.body.expectedRevision, r.body.idempotencyKey));
  for (const action of ['apply', 'reject', 'undo', 'restore'] as const) app.post<{ Params: Params; Body: { expectedRevision: number; changeIds?: string[]; sentenceIndices?: number[] } }>(`${base}/revisions/:revisionId/${action}`, { schema: { body: { type: 'object', additionalProperties: false, required: ['expectedRevision'], properties: {
    expectedRevision: { type: 'integer', minimum: 0 }, changeIds: { type: 'array', maxItems: 1000, items: text(300) }, sentenceIndices: { type: 'array', maxItems: 100, items: { type: 'integer', minimum: 0 } } } } } }, async r => actOnRevision(r.params.language, r.params.sessionId, r.params.revisionId, action, r.body.expectedRevision, r.body.changeIds, r.body.sentenceIndices));
};
export default routes;
