import { useRef, useState } from 'react';
import { useI18n } from '../../i18n/context';
import type { ImportSession } from '../../types';
export default function ImportSaveComparison({ compare, resolve, disabled }: {
  compare: () => Promise<{ local: ImportSession; remote: ImportSession }>;
  resolve: (remote: ImportSession, reapply: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<{ local: ImportSession; remote: ImportSession } | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function show() {
    setBusy(true); setError(null);
    try { setVersions(await compare()); dialog.current?.showModal(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  function choose(reapply: boolean) {
    if (!versions) return;
    try { resolve(versions.remote, reapply); dialog.current?.close(); setVersions(null); setError(null); }
    catch (e) { setError(String(e)); }
  }
  return <div className="mt-2 text-xs">
    <button type="button" disabled={disabled || busy} onClick={() => void show()} className="rounded border border-gray-600 px-2 py-1 text-indigo-200 disabled:opacity-40">{t('importCompareSaved')}</button>
    {error && !dialog.current?.open && <p role="alert" className="mt-2 text-red-300">{error}</p>}
    <dialog ref={dialog} aria-labelledby="import-save-comparison-title" className="m-auto max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-4xl overflow-y-auto rounded-xl border border-gray-600 bg-gray-900 p-4 text-gray-100 backdrop:bg-black/60">
      <h3 id="import-save-comparison-title" className="mb-3 font-semibold">{t('importCompareSaved')}</h3>
      <div className="grid gap-4 sm:grid-cols-2">{versions && (['local', 'remote'] as const).map(k => <section key={k} className="min-w-0 space-y-3"><h4 className="text-sm text-indigo-200">{t(k === 'local' ? 'importPendingVersion' : 'importSavedVersion')}</h4>{versions[k].paragraphs.flatMap(p => p.sentences).map(s => <div key={s.index} className="rounded border border-gray-700 p-2 text-sm"><p>{s.text}</p>{versions[k].items.filter(i => i.sentenceIndex === s.index && i.status !== 'skipped' && !i.hiddenByRevision).map(i => <p key={i.id} className="mt-2 break-words text-xs text-gray-300">{i.kind === 'word' ? `${i.term} · ${i.meaning ?? ''}` : `${i.statement} · ${i.description}`}</p>)}</div>)}</section>)}</div>
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">{([['importUseSavedVersion', false], ['importReapplyPendingEdits', true]] as const).map(([key, reapply]) => <button key={key} type="button" onClick={() => choose(reapply)} className="rounded border border-indigo-600 px-3 py-2 text-sm">{t(key)}</button>)}<button type="button" className="rounded border border-gray-600 px-3 py-2 text-sm" onClick={() => dialog.current?.close()}>{t('cancel')}</button></div>
    </dialog>
  </div>;
}
