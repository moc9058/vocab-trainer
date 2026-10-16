// Container entrypoint; a separate process holds durable jobs independently of the browser/API.
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Local worker requires FIRESTORE_EMULATOR_HOST');
const { reconcileAnalysisJobs } = await import('./import-job-store.js');
while (true) {
  try { await reconcileAnalysisJobs(true); } catch (err) { console.error('Local import worker:', err instanceof Error ? err.message : 'failed'); }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
