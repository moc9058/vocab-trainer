import { useEffect, useRef, useState } from 'react';
import { contextId, rpc, type SelectionContext } from './runtime';
import { useI18n } from '../i18n/context';
import { useWordQueue } from '../hooks/useWordQueue';
import { useGrammarQueue } from '../hooks/useGrammarQueue';
import { useImportSession } from '../hooks/useImportSession';
import { useImportGroups } from '../hooks/useImportGroups';
import { useImportAnalysisJob } from '../hooks/useImportAnalysisJob';
import { getGrammarSettings } from '../api/grammar';
import { startImportAnalysisJob, resumeImportAnalysisJob, listImportSessions } from '../api/import';
import { DEFAULT_API_ORIGIN } from '../api/transport';
import ImportReview from '../components/import/ImportReview';
import ImportAnalysisProgress from '../components/import/ImportAnalysisProgress';
import ImportDestinationRail from '../components/import/ImportDestinationRail';
import type { ImportSession, ImportSessionSummary } from '../types';

export default function Panel() {
  const { t, language, setLanguage } = useI18n();
  const [connected, setConnected] = useState(false), [checked, setChecked] = useState(false);
  const [automatic, setAutomatic] = useState(() => localStorage.getItem('safariAutoAnalyze') === '1');
  const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<ImportSessionSummary[]>([]);
  const [selection, setSelection] = useState<SelectionContext>();
  const [sourceLabel, setSourceLabel] = useState(''), [includeUrl, setIncludeUrl] = useState(true);
  const [descriptionLanguage, setDescriptionLanguage] = useState('ja');
  const [destination, setDestination] = useState<{ wordGroupId?: string; grammarGroupId?: string; groupBNames: string[] }>({ groupBNames: [] });
  const words = useWordQueue(), grammar = useGrammarQueue(), groups = useImportGroups('chinese', connected);
  const importer = useImportSession({ language: 'chinese', onQueue: words.enqueue, onGrammarQueue: grammar.enqueue,
    descriptionLanguage, onMembershipChanged: groups.reload });
  const monitor = useImportAnalysisJob('chinese', importer.acceptAnalysisSession, () => {});
  const locked = busy || words.pendingTerms.size > 0 || grammar.pendingTerms.size > 0 || importer.saveStatus === 'saving' || importer.saveStatus === 'error' || !!importer.session?.items.some(i => i.status === 'queued');
  const lockedRef = useRef(locked); lockedRef.current = locked;
  const running = monitor.job?.state === 'running' || monitor.job?.state === 'queued';
  function report(err: unknown) { const message = err instanceof Error ? err.message : String(err); setError(/Connection: 404|400.*Invalid source details/.test(message) ? t('safariServerUpdate') : message); }
  useEffect(() => {
    void rpc({ type: 'status' }).then(s => { setConnected(s.connected); setCode(s.pending?.code ?? ''); }).catch(report).finally(() => setChecked(true));
    if (contextId) void rpc<SelectionContext>({ type: 'get-context' }).then(c => { if (!c.menu) setSelection(c); setSourceLabel(localStorage.getItem('safariIncludeTitle') === '0' ? '' : c.source.sourceLabel ?? ''); setIncludeUrl(localStorage.getItem('safariIncludeUrl') !== '0'); }).catch(report);
  }, []);
  useEffect(() => {
    const expired = () => { setConnected(false); loaded.current = false; monitor.stop(); };
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
  }, [monitor.stop]);
  useEffect(() => {
    if (!connected) return;
    void listImportSessions('chinese').then(r => setSessions(r.sessions)).catch(report);
    void getGrammarSettings().then(s => setDescriptionLanguage(s.defaultDefinitionLanguage || 'ja')).catch(report);
  }, [connected]);
  const loaded = useRef(false);
  useEffect(() => {
    if (!connected || !selection?.sessionId || loaded.current) return;
    loaded.current = true;
    void importer.load(selection.sessionId).then(s => { if (s.analysisJobRef) monitor.watch(s.id); }).catch(report);
  }, [connected, selection?.sessionId]);
  useEffect(() => {
    if (!code || connected) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (document.hidden || stopped) return;
      void rpc({ type: 'exchange' }).then(r => { if (r.connected) { setConnected(true); setCode(''); } }).catch(e => { stopped = true; report(e); });
    }, 10000);
    return () => { stopped = true; clearInterval(timer); };
  }, [code, connected]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (lockedRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  async function analyze() {
    if (!selection || busy) return;
    setBusy(true); setError('');
    if (localStorage.getItem('safariAutoAnalyze') === null) { localStorage.setItem('safariAutoAnalyze', '1'); setAutomatic(true); }
    localStorage.setItem('safariIncludeTitle', sourceLabel ? '1' : '0'); localStorage.setItem('safariIncludeUrl', includeUrl ? '1' : '0');
    try {
      let current: ImportSession;
      if (selection.sessionId) current = await importer.load(selection.sessionId);
      else {
        if (selection.expiresAt <= Date.now()) throw new Error(t('safariExpired'));
        const request = selection.request ?? JSON.stringify({ title: sourceLabel || selection.text?.slice(0, 40), text: selection.text,
          paragraphs: [], items: [], analyzeAsJob: true, ingestionId: selection.ingestionId,
          sourceOrigin: { version: 1, method: 'safari-selection', sourceKind: 'unknown', sourceLabel: sourceLabel || undefined,
            sourceUrl: includeUrl ? selection.source.sourceUrl : undefined, capturedAt: new Date().toISOString(), textConfirmed: true },
          ...destination, focusedSentenceIndex: 0, status: 'in-progress' });
        await rpc({ type: 'save-operation', request });
        setSelection(s => s ? { ...s, request } : s);
        current = await importer.create(JSON.parse(request));
        await rpc({ type: 'save-operation', sessionId: current.id });
        setSelection(s => s ? { ...s, sessionId: current.id, text: undefined, request: undefined } : s);
      }
      if (current.analysisJobRef) await resumeImportAnalysisJob('chinese', current.id, crypto.randomUUID());
      else await startImportAnalysisJob('chinese', current.id, selection.jobKey, current.analysisRevision ?? 0);
      monitor.watch(current.id, { key: selection.jobKey, revision: current.analysisRevision ?? 0 });
    } catch (e) { report(e); }
    finally { setBusy(false); }
  }
  const autoStarted = useRef(false);
  const analyzeRef = useRef(analyze); analyzeRef.current = analyze;
  useEffect(() => {
    if (!automatic || !connected || !selection || selection.sessionId || selection.request || groups.loading || autoStarted.current) return;
    autoStarted.current = true;
    const timer = setTimeout(() => void analyzeRef.current(), 0);
    return () => clearTimeout(timer);
  }, [automatic, connected, selection, groups.loading]);
  async function close() {
    if (locked) return;
    await importer.prepareAnalysis(); // Drain autosave before unmounting; queued registrations disable this action.
    if (contextId) await rpc({ type: 'close' });
    if (window.top === window) window.close();
  }
  const button = 'min-h-11 rounded-lg border border-gray-600 px-3 py-2 text-sm disabled:opacity-40';
  return <main className="min-h-screen bg-gray-900 text-gray-200">
    <header className="flex flex-wrap items-center gap-2 border-b border-gray-700 p-3">
      <strong className="mr-auto">Vocab Trainer</strong>
      <select aria-label={t('safariLanguage')} value={language} onChange={e => setLanguage(e.target.value as typeof language)} className="rounded bg-gray-800 p-2">
        <option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option>
      </select>
      {contextId && <button className={button} disabled={locked} onClick={() => void importer.prepareAnalysis().then(() => rpc({ type: 'detach' })).catch(report)}>{t('safariTab')}</button>}
      <button className={button} disabled={locked} onClick={() => void close().catch(report)}>{t('mathClose')}</button>
    </header>
    {error && <p role="alert" className="whitespace-pre-wrap p-3 text-red-300">{error}</p>}
    {locked && <p role="status" className="p-3 text-amber-200">{t('safariPendingWrites')}</p>}
    {!connected ? <section className="space-y-3 p-4"><p>{t('safariPermissionHelp')}</p><p>{t('safariConnectHelp')}</p>
      {code && <p>{t('safariCode')}: <strong className="font-mono">{code}</strong></p>}
      <button className={button} disabled={!checked || busy} onClick={() => {
        setBusy(true); setError(''); void rpc({ type: 'connect' }).then(r => setCode(r.code)).catch(report).finally(() => setBusy(false));
      }}>{t('safariConnect')}</button>
    </section> : <>
      {!importer.session && !selection && <ul className="space-y-2 p-3">{sessions.map(s => <li key={s.id}><button className={button} onClick={() => {
        void rpc({ type: 'save-operation', sessionId: s.id }).then(() => setSelection({ sessionId: s.id, source: {}, ingestionId: crypto.randomUUID(), jobKey: crypto.randomUUID(), expiresAt: Date.now() + 86400000 })).catch(report);
      }}>{s.title}</button></li>)}</ul>}
      {!importer.session && <section className="space-y-4 p-4">
        {selection ? <>
          <p>{t('safariSendNotice')}</p><p>{t('safariChinese')}</p>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-gray-800 p-3">{selection.text ?? (selection.request ? JSON.parse(selection.request).text : '')}</pre>
          <label className="block">{t('captureSourceLabel')}<input maxLength={100} value={sourceLabel} disabled={!!selection.request} onChange={e => setSourceLabel(e.target.value)} className="mt-1 block w-full rounded bg-gray-800 p-2" /></label>
          {selection.source.sourceUrl && <label className="block break-all"><input type="checkbox" disabled={!!selection.request} checked={includeUrl} onChange={e => setIncludeUrl(e.target.checked)} /> {selection.source.sourceUrl}</label>}
          <p>{t('captureExplanationLanguage')}: {descriptionLanguage}</p>
          <ImportDestinationRail language="chinese" allWordGroups={groups.wordGroups} allGrammarGroups={groups.grammarGroups} {...destination} onChange={patch => setDestination(d => ({ ...d, ...patch }))} />
          <button className={button} disabled={busy} onClick={() => void analyze()}>{busy ? t('importAnalyzing') : t('importAnalyze')}</button>
        </> : <p>{t('safariPermissionHelp')}</p>}
      </section>}
      {importer.session && <>
        {(running || busy || monitor.error) && <section className="p-3"><p>{monitor.reconnecting ? t('importJobReconnecting') : t('importAnalyzing')}</p>
          <ImportAnalysisProgress job={monitor.job} session={importer.session} />
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-800 p-3">{importer.session.text}</pre>
          <ol className="mt-3 space-y-3">{importer.session.paragraphs.flatMap(p => p.sentences).map(sentence => <li key={sentence.index}>
            <p>{sentence.text}</p><p className="text-sm text-gray-400">{importer.session!.items.filter(i => i.sentenceIndex === sentence.index).map(i => i.kind === 'word' ? i.term : i.statement).join(' · ')}</p>
          </li>)}</ol>
          {monitor.error && <p role="alert">{monitor.error}</p>}
          {running && <button className={button} onClick={() => void monitor.pause()}>{t('importJobPause')}</button>}
        </section>}
        {!running && !busy && <ImportReview session={importer.session} allWordGroups={groups.wordGroups} allGrammarGroups={groups.grammarGroups}
          membershipOverlay={importer.membershipOverlay} saveStatus={importer.saveStatus} saveError={importer.saveError}
          onCompareSaved={importer.compareSaved} onResolveSaved={importer.resolveSaved} onRetrySave={importer.retrySave}
          onPrepareRevision={importer.prepareAnalysis} onAcceptRevision={importer.acceptAnalysisSession} onPatch={importer.patch}
          onSetItems={importer.setItems} onPatchItem={importer.patchItem} onRegister={importer.registerItem} onExit={() => void close().catch(report)}
          onContinueAnalysis={() => void analyze()} />}
        <a className="m-3 block underline" target="_blank" rel="noreferrer" href={`${DEFAULT_API_ORIGIN}/chinese/import?session=${encodeURIComponent(importer.session.id)}`}>{t('safariWeb')}</a>
      </>}
      <section className="space-y-3 p-3"><label className="block text-sm"><input type="checkbox" checked={automatic} onChange={e => { setAutomatic(e.target.checked); localStorage.setItem('safariAutoAnalyze', e.target.checked ? '1' : '0'); }} /> {t('safariAutomatic')}</label><button className={button} disabled={locked} onClick={() => void rpc({ type: 'disconnect' }).then(() => { setConnected(false); setSelection(undefined); }).catch(report)}>{t('safariDisconnect')}</button></section>
    </>}
  </main>;
}
