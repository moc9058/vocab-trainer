import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/context';
import type { ImportAnalysisJobSummary, ImportSession } from '../../types';

export default function ImportAnalysisProgress({ job, session }: { job: ImportAnalysisJobSummary | null; session: ImportSession | null }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const chunks = session?.analysisProgress?.chunks ?? [];
  const total = job?.totalCharacters ?? chunks.join('').length;
  const completed = job?.completedCharacters ?? chunks.slice(0, job?.nextBatch ?? session?.analysisProgress?.nextChunk ?? 0).join('').length;
  const percent = total ? Math.min(job?.state === 'completed' ? 100 : 99, Math.floor(completed / total * 100)) : 0;
  const progress = job?.state === 'running' ? job.progress : undefined;
  const seconds = (at: string) => Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  const stageKeys = { waiting: 'importProgressWaiting', generating: 'importProgressGenerating', validating: 'importProgressValidating', saving: 'importProgressSaving' } as const;
  const stage = job?.pauseRequested ? t('importJobPausing') : progress ? t(stageKeys[progress.stage]) : job?.retryAt ? t('importProgressRetry') : t(job?.state === 'running' ? 'importProgressWaiting' : 'importProgressQueued');
  return <section className="mb-4 rounded-lg border border-indigo-800 bg-indigo-950/30 p-4" aria-label={t('importProgressTitle')}>
    <div className="mb-2 flex justify-between gap-3 text-sm text-gray-200">
      <span>{t('importProgressSaved')}: {completed.toLocaleString()} / {total.toLocaleString()} {t('importProgressCharacters')}</span>
      <span>{percent}%</span>
    </div>
    <div role="progressbar" aria-label={t('importProgressSaved')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      className="h-2 overflow-hidden rounded bg-gray-700"><div className="h-full bg-indigo-400 transition-[width]" style={{ width: `${percent}%` }} /></div>
    <p className="mt-2 text-sm text-gray-400">{t('importProgressSentences')}: {job?.completedSentences ?? 0}</p>
    <p className="mt-3 text-sm text-indigo-200" role="status">{stage}{job ? ` · ${Math.min(job.nextBatch + 1, job.totalBatches)} / ${job.totalBatches}` : ''}</p>
    {(progress || job?.retryAt) && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
      <span>{t('importProgressAttempt')}: {progress?.attempt ?? job?.attempt ?? 0} / 3</span>
      {progress && <span>{t('importProgressElapsed')}: {seconds(progress.startedAt)}s</span>}
      {progress?.lastReceivedAt && <span>{t('importProgressLastReceived')}: {seconds(progress.lastReceivedAt)}s</span>}
      {progress && progress.receivedCharacters > 0 && <span>{t('importProgressReceived')}: {progress.receivedCharacters.toLocaleString()} {t('importProgressCharacters')}</span>}
      {job?.retryAt && <span>{t('importProgressRetryIn')}: {Math.max(0, Math.ceil((Date.parse(job.retryAt) - now) / 1000))}s</span>}
    </div>}
    <p className="mt-3 text-xs text-gray-500">{t('importProgressHint')}</p>
  </section>;
}
