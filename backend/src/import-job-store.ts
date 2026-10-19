import { createProgressReporter } from './import-progress.js';
import { randomUUID } from 'node:crypto';
import { FieldValue } from '@google-cloud/firestore';
import { db, getAllGrammarItems, getImportConfig, lookupWordsByTerms } from './firestore.js';
import { callLLM, resolveModel, stripMarkdownFences } from './llm.js';
import { compactImportSchema, COMPACT_IMPORT_INSTRUCTIONS } from './import-analysis-config.js';
import { lowercaseGrammarAbbreviations, normalizeAnalysis } from './import-analysis.js';
import { sourceMatchesSentences } from './import-reading-analysis.js';
import { appendImportPart, ImportCheckpointError } from './import-parts.js';
import { importJobError, importSentenceTexts, JOB_LEASE_MS, MAX_JOB_ATTEMPTS, jobActive, remainingJobChunks, planImportBatches, sourceHash, type ImportJob } from './import-jobs.js';
import { enqueueImportJob, jobsConfigured, localJobs } from './import-task-dispatch.js';
import type { ImportAnalysisResult, ImportSession, ImportAnalysisProgress } from './types.js';
import type { CompletionUsage } from 'openai/resources/completions';

export const jobCollection = db.collection('import_analysis_jobs');
const sessions = db.collection('import_sessions');
const stamp = () => new Date().toISOString();
const readJob = (value: FirebaseFirestore.DocumentSnapshot) => value.exists ? value.data() as ImportJob : null;
export async function getAnalysisJob(sessionId: string): Promise<ImportJob | null> { return readJob(await jobCollection.doc(sessionId).get()); }
const sessionPatch = (job: ImportJob) => ({ analysisJobRef: { version: 2 as const, jobId: job.id, generation: job.generation }, analysisRevision: job.revision, analysisState: job.state, updatedAt: stamp() });
function checkSession(s: ImportSession | null, language: string) {
  if (!s || s.language !== language) throw new ImportCheckpointError(404, 'Import session not found');
}
function sessionData(doc: FirebaseFirestore.DocumentSnapshot): ImportSession | null { return doc.exists ? { id: doc.id, ...doc.data() } as ImportSession : null; }

export async function createImportSnapshot(language: string) {
  const [config, grammar, model] = await Promise.all([getImportConfig(), getAllGrammarItems(language), resolveModel('full', 'import/analyze-part')]);
  const base = config.analyzePrompts?.[language];
  if (!base) throw new ImportCheckpointError(400, 'No import prompt configured for language');
  const examples = grammar.map(g => lowercaseGrammarAbbreviations(g.statement)).filter(Boolean).slice(0, 40).sort();
  const system = base + COMPACT_IMPORT_INSTRUCTIONS + '\nAnalyze ONLY target. before/after are context; never output them. Preserve all target sentences verbatim. The sentenceTexts array specifies sentence boundaries: output exactly one sentence per entry, in order.'
    + (examples.length ? '\nExisting grammar notation examples:\n' + examples.map(s => `- ${s}`).join('\n') : '');
  return { model, system, schema: compactImportSchema(config.analyzeSchema) };
}

/** Durable dispatch intent lives in the job transaction; queue failure cannot erase it. */
export async function dispatchAnalysisJob(job: ImportJob): Promise<void> {
  if (job.state !== 'queued' || localJobs()) return;
  try {
    await enqueueImportJob(job);
    await db.runTransaction(async tx => {
      const ref = jobCollection.doc(job.id); const current = readJob(await tx.get(ref));
      if (current?.state === 'queued' && current.generation === job.generation && current.sequence === job.sequence) {
        tx.update(ref, { nextWakeAt: Math.max(Date.now() + 90_000, job.nextWakeAt + 90_000), dispatchError: FieldValue.delete() });
      }
    });
  } catch (err) {
    console.error(JSON.stringify({ message: 'Import dispatch pending', jobId: job.id, code: (err as { code?: number }).code }));
    // Scheduler/local runner retries the durable intent. Do not change to failed or start in this process.
    await db.runTransaction(async tx => {
      const ref = jobCollection.doc(job.id); const current = readJob(await tx.get(ref));
      if (current?.state === 'queued' && current.generation === job.generation && current.sequence === job.sequence)
        tx.update(ref, { dispatchError: 'IMPORT_QUEUE_DELAY', nextWakeAt: Date.now() + 30_000 });
    });
  }
}

export async function startAnalysisJob(language: string, sessionId: string, key: string, revision?: number): Promise<ImportJob> {
  if (!jobsConfigured()) throw new ImportCheckpointError(503, 'Import worker is not configured');
  const existing = await getAnalysisJob(sessionId);
  // Still check article existence/language; a deleted job tombstone is not a public read.
  const initial = sessionData(await sessions.doc(sessionId).get()); checkSession(initial, language);
  if (existing) return existing;
  if (initial!.analysisRevision === undefined && Date.now() < Number(process.env.IMPORT_JOB_MIGRATE_AFTER ?? 0)) throw new ImportCheckpointError(409, 'Previous analysis requests are settling. Wait a few minutes, then continue.');
  if ((initial!.analysisRevision ?? 0) !== (revision ?? 0)) throw new ImportCheckpointError(409, 'Reload before starting analysis');
  const frozen = await createImportSnapshot(language);
  if (Buffer.byteLength(JSON.stringify(frozen)) > 850_000) throw new ImportCheckpointError(413, 'Analysis configuration is too large');
  const job = await db.runTransaction(async tx => {
    const sref = sessions.doc(sessionId), jref = jobCollection.doc(sessionId);
    const [sdoc, jdoc] = await Promise.all([tx.get(sref), tx.get(jref)]);
    const s = sessionData(sdoc); checkSession(s, language);
    const current = readJob(jdoc); if (current) return current;
    if ((s!.analysisRevision ?? 0) !== (revision ?? 0)) throw new ImportCheckpointError(409, 'Reload before starting analysis');
    if (s!.activeRevisionId) throw new ImportCheckpointError(409, 'A revision is running.');
    if (s!.items.some(i => i.status === 'queued')) throw new ImportCheckpointError(409, 'Wait for pending registrations');
    const { chunks, next } = remainingJobChunks(s!);
    const done = next === chunks.length;
    const now = stamp();
    const value: ImportJob = { version: 2, id: sessionId, sessionId, language, generation: 1, sourceHash: sourceHash(s!.text),
      state: done ? 'completed' : 'queued', revision: (s!.analysisRevision ?? 0) + 1, nextBatch: next, totalBatches: chunks.length,
      completedSentences: s!.paragraphs.flatMap(p => p.sentences).length, pauseRequested: false,
      chunks, attempts: 0, sequence: 0, operationKey: key, snapshot: frozen, createdAt: now, updatedAt: now,
      nextWakeAt: done ? Number.MAX_SAFE_INTEGER : Date.now(), cleanupAt: done ? Date.now() + 7 * 86400000 : Number.MAX_SAFE_INTEGER };
    tx.set(jref, value); tx.update(sref, sessionPatch(value));
    return value;
  });
  await dispatchAnalysisJob(job); return job;
}

export async function changeAnalysisJob(language: string, sessionId: string, action: 'resume' | 'pause', key: string): Promise<ImportJob> {
  const job = await db.runTransaction(async tx => {
    const sref = sessions.doc(sessionId), jref = jobCollection.doc(sessionId);
    const opref = jref.collection('operations').doc(sourceHash(key));
    const [sdoc, jdoc, opdoc] = await Promise.all([tx.get(sref), tx.get(jref), tx.get(opref)]);
    const s = sessionData(sdoc); checkSession(s, language);
    if (s!.activeRevisionId) throw new ImportCheckpointError(409, 'A revision is running.');
    const j = readJob(jdoc); if (!j) throw new ImportCheckpointError(404, 'Analysis job not found');
    if (opdoc.exists) return j;
    const savedResult = action === 'resume' ? await tx.get(jref.collection('results').doc(`${j.nextBatch}`)) : null;
    let replanned = false;
    if (action === 'pause' && jobActive(j.state)) {
      j.pauseRequested = true;
      if (j.state === 'queued') { j.state = 'paused'; j.nextWakeAt = Number.MAX_SAFE_INTEGER; }
    } else if (action === 'resume' && (j.state === 'paused' || (j.state === 'failed' && j.error?.retryable))) {
      if (s!.items.some(i => i.status === 'queued')) throw new ImportCheckpointError(409, 'Wait for pending registrations');
      if (!savedResult?.exists && ['IMPORT_TIMEOUT', 'IMPORT_OUTPUT_LIMIT'].includes(j.error?.code ?? '')) {
        const source = j.chunks[j.nextBatch];
        const smaller = planImportBatches(source, j.language, Math.max(1, Math.floor(source.length / 2)));
        if (smaller.length > 1) {
          j.chunks.splice(j.nextBatch, 1, ...smaller); j.totalBatches = j.chunks.length; replanned = true;
        }
      }
      j.state = 'queued'; j.generation++; j.sequence++; j.attempts = 0; j.pauseRequested = false;
      delete j.lease; delete j.error; delete j.progress; delete j.retryAt; j.nextWakeAt = Date.now();
    }
    j.revision++; j.updatedAt = stamp();
    tx.set(jref, j); tx.set(opref, { action, createdAt: j.updatedAt }); tx.update(sref, { ...sessionPatch(j), ...(replanned ? { analysisProgress: { ...s!.analysisProgress!, chunks: j.chunks } } : {}) });
    return j;
  });
  await dispatchAnalysisJob(job); return job;
}

export interface ImportTaskPayload { jobId: string; generation: number; batch: number; sequence: number }
export async function claimAnalysisJob(payload: ImportTaskPayload): Promise<ImportJob | null> {
  return db.runTransaction(async tx => {
    const jref = jobCollection.doc(payload.jobId); const j = readJob(await tx.get(jref));
    if (!j || j.generation !== payload.generation || j.nextBatch !== payload.batch || j.sequence !== payload.sequence || !jobActive(j.state)) return null;
    const sref = sessions.doc(j.sessionId); const s = sessionData(await tx.get(sref));
    if (!s || s.analysisJobRef?.generation !== j.generation || sourceHash(s.text) !== j.sourceHash || s.analysisProgress?.nextChunk !== j.nextBatch || JSON.stringify(s.analysisProgress.chunks) !== JSON.stringify(j.chunks)) {
      j.state = 'cancelled'; j.revision++; j.updatedAt = stamp(); j.nextWakeAt = Number.MAX_SAFE_INTEGER; j.cleanupAt = Date.now() + 7 * 86400000;
      tx.set(jref, j); if (s?.analysisJobRef?.generation === j.generation) tx.update(sref, sessionPatch(j)); return null;
    }
    if (j.lease && j.lease.until > Date.now()) throw new ImportCheckpointError(503, 'Analysis already running');
    const result = await tx.get(jref.collection('results').doc(`${j.nextBatch}`));
    if (!result.exists && j.attempts >= MAX_JOB_ATTEMPTS) {
      j.state = 'failed'; j.error = { code: 'IMPORT_ATTEMPT_LIMIT', retryable: true }; j.revision++;
      j.nextWakeAt = Number.MAX_SAFE_INTEGER; j.updatedAt = stamp(); tx.set(jref, j); tx.update(sref, sessionPatch(j)); return null;
    }
    const attemptId = randomUUID();
    if (!result.exists) j.attempts++;
    delete j.retryAt;
    j.progress = { stage: result.exists ? 'saving' : 'waiting', attempt: j.attempts, startedAt: stamp(), updatedAt: stamp(), receivedCharacters: 0 };
    j.state = 'running'; j.lease = { token: randomUUID(), until: Date.now() + JOB_LEASE_MS, attemptId };
    j.nextWakeAt = j.lease.until; j.revision++; j.updatedAt = stamp();
    tx.set(jref, j); tx.update(sref, sessionPatch(j));
    tx.set(jref.collection('attempts').doc(attemptId), { startedAt: j.updatedAt, batch: j.nextBatch, generation: j.generation, usageUnknown: !result.exists, llmStarted: !result.exists, model: j.snapshot.model });
    return j;
  });
}
function sameLease(current: ImportJob | null, worker: ImportJob): current is ImportJob {
  return !!current && current.state === 'running' && current.generation === worker.generation && current.nextBatch === worker.nextBatch && current.lease?.token === worker.lease?.token;
}
/** Progress is advisory; never increment the session's content revision for a delta. */
export async function saveAnalysisProgress(worker: ImportJob, progress: ImportAnalysisProgress): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = jobCollection.doc(worker.id); const current = readJob(await tx.get(ref));
    if (sameLease(current, worker)) tx.update(ref, { progress });
  });
}
export async function heartbeatAnalysisJob(worker: ImportJob): Promise<void> {
  await db.runTransaction(async tx => {
    const ref = jobCollection.doc(worker.id); const j = readJob(await tx.get(ref));
    if (sameLease(j, worker)) tx.update(ref, { lease: { ...j.lease!, until: Date.now() + JOB_LEASE_MS }, nextWakeAt: Date.now() + JOB_LEASE_MS });
  });
}

/** One usage receipt and one existing daily increment per actual attempt, in one transaction. */
export async function saveUsage(job: ImportJob, usage: CompletionUsage | undefined, model: string) {
  if (!usage) return;
  const ref = jobCollection.doc(job.id).collection('attempts').doc(job.lease!.attemptId);
  const now = stamp(), date = now.slice(0, 10);
  const route = job.kind === 'revision'
    ? job.snapshot.schema.name === 'import_word_assist' ? 'import/word-assist' : 'import/revision'
    : 'import/analyze-part';
  await db.runTransaction(async tx => {
    const doc = await tx.get(ref); if (doc.data()?.usageUnknown === false) return;
    const values = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0, thoughtsTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 };
    tx.set(ref, { model, usage: values, usageUnknown: false }, { merge: true });
    tx.set(db.collection('token_usage').doc(`import-${job.id}-${job.lease!.attemptId}`), { timestamp: now, model, caller: 'import-worker', route, ...values });
    tx.set(db.collection('token_usage_daily').doc(`${model}_${date}`), { model, date, totalCalls: FieldValue.increment(1),
      ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, FieldValue.increment(v)])),
      [`byRoute.${route}.calls`]: FieldValue.increment(1), [`byRoute.${route}.promptTokens`]: FieldValue.increment(values.promptTokens),
      [`byRoute.${route}.completionTokens`]: FieldValue.increment(values.completionTokens), [`byRoute.${route}.totalTokens`]: FieldValue.increment(values.totalTokens) }, { merge: true });
  });
}
interface SavedResult { usageReceipt?: { attemptId: string; usage: CompletionUsage; model: string }; analysis: ImportAnalysisResult; existing: Record<string, string>; existingGrammar: Record<string, string> }
export async function commitAnalysisResult(worker: ImportJob, result: SavedResult): Promise<ImportJob | null> {
  return db.runTransaction(async tx => {
    const jref = jobCollection.doc(worker.id), sref = sessions.doc(worker.sessionId);
    const [jd, sd] = await Promise.all([tx.get(jref), tx.get(sref)]); const j = readJob(jd), s = sessionData(sd);
    if (!sameLease(j, worker) || !s || s.analysisJobRef?.generation !== j.generation || sourceHash(s.text) !== j.sourceHash || s.analysisProgress?.nextChunk !== j.nextBatch || JSON.stringify(s.analysisProgress.chunks) !== JSON.stringify(j.chunks)) return null;
    const next = appendImportPart(s, j.nextBatch, result.analysis, result.existing, result.existingGrammar);
    delete j.progress;
    j.nextBatch++; j.attempts = 0; j.sequence++; j.revision++; delete j.lease; delete j.error; j.updatedAt = stamp();
    j.completedSentences = next.paragraphs.flatMap(p => p.sentences).length;
    j.state = j.nextBatch === j.totalBatches ? 'completed' : j.pauseRequested ? 'paused' : 'queued';
    j.nextWakeAt = j.state === 'queued' ? Date.now() : Number.MAX_SAFE_INTEGER;
    if (j.state === 'completed') j.cleanupAt = Date.now() + 7 * 86400000;
    const { id: _, ...data } = { ...next, ...sessionPatch(j) };
    tx.set(sref, data); tx.set(jref, j);
    tx.set(jref.collection('attempts').doc(worker.lease!.attemptId), { finishedAt: stamp(), state: 'completed' }, { merge: true });
    return j;
  });
}
export async function failAnalysisJob(worker: ImportJob, error: unknown): Promise<ImportJob | null> {
  return db.runTransaction(async tx => {
    const ref = jobCollection.doc(worker.id), sref = sessions.doc(worker.sessionId);
    const [jd, sd] = await Promise.all([tx.get(ref), tx.get(sref)]); const j = readJob(jd);
    if (!sameLease(j, worker)) return null;
    j.error = importJobError(error); delete j.lease; j.sequence++; j.revision++; j.updatedAt = stamp();
    if (j.error.code === 'IMPORT_OUTPUT_LIMIT' && importSentenceTexts(j.chunks[j.nextBatch], j.language).length > 1) j.error.retryable = true;
    j.state = j.pauseRequested ? 'paused' : j.error.retryable && j.error.code !== 'IMPORT_OUTPUT_LIMIT' && j.attempts < MAX_JOB_ATTEMPTS ? 'queued' : 'failed';
    j.nextWakeAt = j.state === 'queued' ? Date.now() + j.attempts * 30_000 : Number.MAX_SAFE_INTEGER;
    if (j.state === 'queued') j.retryAt = new Date(j.nextWakeAt).toISOString(); else delete j.retryAt;
    tx.set(ref, j); if (sd.exists) tx.update(sref, sessionPatch(j));
    tx.set(ref.collection('attempts').doc(worker.lease!.attemptId), { finishedAt: stamp(), state: 'failed', error: j.error }, { merge: true });
    return j;
  });
}

export async function runAnalysisTask(payload: ImportTaskPayload): Promise<void> {
  if ((await getAnalysisJob(payload.jobId))?.kind === "revision") {
    await (await import("./import-revision-store.js")).runRevisionTask(payload); return;
  }
  const job = await claimAnalysisJob(payload); if (!job) return;
  const timer = setInterval(() => { void heartbeatAnalysisJob(job).catch(() => {}); }, 30_000); timer.unref();
  const reporter = createProgressReporter(job.progress!, progress => saveAnalysisProgress(job, progress),
    () => console.warn(JSON.stringify({ message: 'Import progress update failed', jobId: job.id })));
  try {
    const resultRef = jobCollection.doc(job.id).collection('results').doc(`${job.nextBatch}`);
    const saved = await resultRef.get();
    let result = saved.exists ? saved.data() as SavedResult : undefined;
    const source = job.chunks[job.nextBatch];
    if (!result) {
      let receipt: SavedResult['usageReceipt'];
      let analysis: ImportAnalysisResult = { paragraphs: [], words: [], grammar: [] };
      if (source.trim()) {
        const raw = await callLLM({ system: job.snapshot.system,
          user: JSON.stringify({ target: source, sentenceTexts: importSentenceTexts(source, job.language), before: job.chunks[job.nextBatch - 1]?.slice(-300) ?? '', after: job.chunks[job.nextBatch + 1]?.slice(0, 300) ?? '' }),
          schema: job.snapshot.schema, route: 'import/analyze-part', tier: 'full',
          onChunk: chunk => reporter.receive(chunk.length),
          worker: { model: job.snapshot.model, onUsage: async (usage, model) => {
            if (usage) receipt = { attemptId: job.lease!.attemptId, usage, model };
            try { await saveUsage(job, usage, model); } catch { /* Persist receipt with result, then retry accounting without repeating the model. */ }
          } } });
        await reporter.stage('validating');
        analysis = normalizeAnalysis(stripMarkdownFences(raw), job.language).analysis;
        const actual = analysis.paragraphs.flatMap(p => p.sentences).map(s => s.text);
        const expected = importSentenceTexts(source, job.language);
        if (!sourceMatchesSentences(source, actual) || actual.length !== expected.length || actual.some((text, i) => text.trim() !== expected[i])) throw new Error('IMPORT_SOURCE_MISMATCH');
      }
      const existing: Record<string, string> = {}, existingGrammar: Record<string, string> = {};
      for (const match of await lookupWordsByTerms(job.language, [...new Set(analysis.words.map(w => w.term.trim()).filter(Boolean))])) existing[match.term] = match.id;
      for (const g of await getAllGrammarItems(job.language)) { const key = lowercaseGrammarAbbreviations(g.statement ?? '').trim(); if (key && !existingGrammar[key]) existingGrammar[key] = g.id; }
      result = { analysis, existing, existingGrammar, ...(receipt ? { usageReceipt: receipt } : {}) };
      if (Buffer.byteLength(JSON.stringify(result)) > 850_000) throw new Error('IMPORT_STORAGE_LIMIT');
      await reporter.stage('saving');
      // Persist under lease fence: a delayed/obsolete worker cannot replace a valid result.
      await db.runTransaction(async tx => {
        const current = readJob(await tx.get(jobCollection.doc(job.id)));
        if (!sameLease(current, job)) throw new Error('Obsolete analysis lease');
        tx.set(resultRef, result!);
      });
    }
    if (result.usageReceipt) await saveUsage({ ...job, lease: { ...job.lease!, attemptId: result.usageReceipt.attemptId } }, result.usageReceipt.usage, result.usageReceipt.model);
    await reporter.stop();
    const next = await commitAnalysisResult(job, result);
    if (next) await dispatchAnalysisJob(next);
  } catch (err) {
    await reporter.stop();
    const next = await failAnalysisJob(job, err);
    console.error(JSON.stringify({ message: 'Import worker attempt failed', jobId: job.id, attemptId: job.lease!.attemptId, error: importJobError(err) }));
    if (next) await dispatchAnalysisJob(next);
  } finally { clearInterval(timer); await reporter.stop(); }
}

/** Bounded scan using single-field indexes. Also recovers a task that exhausted queue delivery retries. */
export async function reconcileAnalysisJobs(runLocally = false): Promise<number> {
  const docs = await jobCollection.where('nextWakeAt', '<=', Date.now()).limit(20).get();
  for (const doc of docs.docs) {
    let j = readJob(doc)!;
    if (j.kind === "revision") { await (await import("./import-revision-store.js")).reconcileRevisionJob(j, runLocally); continue; }
    if (j.state === 'running') {
      await db.runTransaction(async tx => {
        const ref = doc.ref; const current = readJob(await tx.get(ref));
        if (current?.state === 'running' && current.lease!.until <= Date.now()) {
          const sref = sessions.doc(current.sessionId); const sdoc = await tx.get(sref);
          current.state = !sdoc.exists ? 'cancelled' : current.pauseRequested ? 'paused' : 'queued';
          current.sequence++; current.revision++; current.updatedAt = stamp();
          current.nextWakeAt = current.state === 'queued' ? Date.now() : Number.MAX_SAFE_INTEGER;
          if (current.state === 'cancelled') current.cleanupAt = Date.now() + 7 * 86400000;
          delete current.lease;
          tx.set(ref, current); if (sdoc.exists) tx.update(sref, sessionPatch(current));
        }
      });
      j = (await getAnalysisJob(j.id))!;
    } else if (j.state === 'queued' && !runLocally) {
      // New sequence recovers tasks already removed by Cloud Tasks after exhausting delivery retries.
      j = await db.runTransaction(async tx => {
        const current = readJob(await tx.get(doc.ref))!;
        if (current.state === 'queued' && current.nextWakeAt <= Date.now()) { current.sequence++; tx.set(doc.ref, current); }
        return current;
      });
    }
    if (j.state !== 'queued') continue;
    if (runLocally) await runAnalysisTask({ jobId: j.id, generation: j.generation, batch: j.nextBatch, sequence: j.sequence });
    else await dispatchAnalysisJob(j);
  }
  const expired = await jobCollection.where('cleanupAt', '<=', Date.now()).limit(5).get();
  for (const doc of expired.docs) {
    const j = readJob(doc)!;
    if (j.kind === 'revision') { await (await import('./import-revision-store.js')).cleanupRevisionJob(j); continue; }
    if (j.state === 'cancelled') await db.recursiveDelete(doc.ref);
    else if (j.state === 'completed') {
      let remaining = false;
      for (const name of ['results', 'attempts']) {
        const old = await doc.ref.collection(name).limit(100).get();
        if (old.size === 100) remaining = true;
        if (old.size) { const batch = db.batch(); old.docs.forEach(d => batch.delete(d.ref)); await batch.commit(); }
      }
      await doc.ref.update({ snapshot: FieldValue.delete(), chunks: [], cleanupAt: remaining ? Date.now() + 60_000 : Number.MAX_SAFE_INTEGER });
    }
  }
  return docs.size;
}
