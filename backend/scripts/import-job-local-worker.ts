import './_project-env.js';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Local worker requires FIRESTORE_EMULATOR_HOST');
const { reconcileAnalysisJobs } = await import('../src/import-job-store.js');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
while (!stopping) {
  try { await reconcileAnalysisJobs(true); } catch (err) { console.error('Local import worker:', err instanceof Error ? err.message : 'failed'); }
  if (!stopping) await new Promise(resolve => setTimeout(resolve, 2000));
}
