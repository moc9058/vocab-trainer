import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/context';
import { convertImportGrammar, createImportRevision, getImportRevision, getImportSession, importRevisionAction, listImportRevisions } from '../../api/import';
import type { ImportConversionInput, ImportGrammarItem, ImportRevision, ImportRevisionRequest, ImportSession } from '../../types';
import ImportComprehension from './ImportComprehension';

const control = 'w-full min-w-0 rounded-lg border border-gray-600 bg-gray-950 p-2 text-sm text-gray-100 disabled:opacity-40';
const button = 'rounded-lg border border-indigo-600 px-3 py-2 text-sm text-indigo-100 disabled:opacity-40';
interface Props {
  session: ImportSession;
  prepare: () => Promise<ImportSession | null>;
  accept: (s: ImportSession) => void;
  onBusy: (value: boolean) => void;
  conversion: ImportGrammarItem | null;
  onCloseConversion: () => void;
  onOpenConversion: (item: ImportGrammarItem) => void;
  selection: number | null;
}
export default function ImportRevisionPanel({ session, prepare, accept, onBusy, conversion, onCloseConversion, onOpenConversion, selection }: Props) {
  const { t } = useI18n();
  const all = session.paragraphs.flatMap(p => p.sentences);
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(all[0]?.index ?? 0), [end, setEnd] = useState(all[0]?.index ?? 0);
  const [update, setUpdate] = useState<ImportRevisionRequest['update']>('both');
  const [instruction, setInstruction] = useState('');
  const [explanationLanguage, setExplanationLanguage] = useState('ja');
  const [revision, setRevision] = useState<ImportRevision | null>(null);
  const [history, setHistory] = useState<ImportRevision[]>([]);
  const [selected, setSelected] = useState<string[]>([]), [explanations, setExplanations] = useState<number[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const requestRef = useRef<ImportRevisionRequest | null>(null);
  const conversionKey = useRef(crypto.randomUUID());
  const [word, setWord] = useState<ImportConversionInput | null>(null);
  const [assisted, setAssisted] = useState<ImportRevision['assistedWord']>();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const running = !!session.activeRevisionId || revision?.state === 'queued' || revision?.state === 'running';
  const acceptRef = useRef(accept); acceptRef.current = accept;
  const monitorId = session.activeRevisionId ?? (revision?.state === 'queued' || revision?.state === 'running' ? revision.id : undefined);
  useEffect(() => { onBusy(busy || running); }, [busy, running, onBusy]);
  useEffect(() => { if (selection !== null) { setStart(selection); setEnd(selection); setOpen(true); setRevision(null); } }, [selection]);
  async function refreshHistory(signal?: AbortSignal) {
    const result = await listImportRevisions(session.language, session.id, signal); setHistory(result.revisions);
  }
  useEffect(() => {
    const c = new AbortController();
    void refreshHistory(c.signal).catch(() => {});
    return () => c.abort();
  }, [session.id]);
  function showProposal(r: ImportRevision) {
    setRevision(r); setOpen(true);
    setSelected(r.changes.map(c => c.id));
    setExplanations(r.request.update === 'grammar' ? [] : r.sentences.map(s => s.index));
    if (r.assistedWord) {
      setAssisted(r.assistedWord);
      const source = session.items.find((i): i is ImportGrammarItem => i.kind === 'grammar' && i.id === r.request.conversion?.itemId && !i.hiddenByRevision && i.status !== 'skipped');
      if (source) onOpenConversion(source);
    }
  }
  useEffect(() => {
    if (!monitorId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const r = await getImportRevision(session.language, session.id, monitorId!, controller.signal);
        if (controller.signal.aborted) return;
        setReconnecting(false); setRevision(r);
        if (r.state === 'queued' || r.state === 'running') { timer = setTimeout(() => void poll(), 3000); return; }
        const s = await getImportSession(session.language, session.id, controller.signal);
        if (controller.signal.aborted) return;
        acceptRef.current(s); showProposal(r); void refreshHistory(controller.signal).catch(() => {});
        if (r.state === 'failed') setError(r.error ?? t('importRevisionFailed'));
      } catch (e) {
        if (controller.signal.aborted) return;
        setReconnecting(true); setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(() => void poll(), 5000);
      }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [monitorId, session.id, session.language]);
  useEffect(() => {
    if (!conversion) { setWord(null); setAssisted(undefined); if (dialog.current?.open) { dialog.current.close(); trigger.current?.focus(); } return; }
    const s = all.find(s => s.index === conversion.sentenceIndex);
    if (!s) return;
    const first = conversion.fixedElements?.[0];
    const excerpt = first?.surface ?? (conversion.excerpt && s.text.includes(conversion.excerpt) ? conversion.excerpt : '');
    const at = first?.range.start ?? (excerpt ? s.text.indexOf(excerpt) : 0);
    const to = first?.range.end ?? at + (excerpt?.length || [...s.text][0]?.length || 1);
    const occurrence = s.readingAnalysis?.occurrences.find(o => o.range.start === at && o.range.end === to);
    setWord({ itemId: conversion.id, start: at, end: to, term: occurrence?.lemma ?? s.text.slice(at, to), meaning: occurrence?.contextualMeaning ?? first?.meaning ?? '', transliteration: occurrence?.transliteration ?? first?.transliteration ?? '', explanationLanguage: occurrence?.explanationLanguage ?? 'ja', mode: 'replace' });
    if (revision?.kind === 'word-assist' && revision.request.conversion?.itemId === conversion.id && revision.state === 'proposed') {
      setWord(revision.request.conversion); setAssisted(revision.assistedWord);
    } else setAssisted(undefined);
    setError(null); conversionKey.current = crypto.randomUUID();
    dialog.current?.showModal();
  }, [conversion?.id]);
  async function generate(assist = false, retry = false) {
    if (busy || running) return;
    setBusy(true); setError(null);
    try {
      const s = await prepare(); if (!s) return;
      const indices = assist && conversion ? [conversion.sentenceIndex] : all.filter(s => s.index >= Math.min(start, end) && s.index <= Math.max(start, end)).map(s => s.index);
      const request: ImportRevisionRequest = retry && requestRef.current ? requestRef.current : { kind: assist ? 'word-assist' : 'regenerate', sentenceIndices: indices, update,
        instruction, explanationLanguage: assist ? word?.explanationLanguage ?? 'ja' : explanationLanguage, expectedRevision: s.contentRevision ?? 0, idempotencyKey: crypto.randomUUID(), ...(assist && word ? { conversion: word } : {}) };
      requestRef.current = request;
      const r = await createImportRevision(s.language, s.id, request);
      showProposal(r);
      requestRef.current = null;
      const saved = await getImportSession(s.language, s.id); accept(saved);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function action(kind: 'apply' | 'reject' | 'undo' | 'restore', item = revision) {
    if (!item || busy || running) return;
    setBusy(true); setError(null);
    try {
      const s = await prepare(); if (!s) return;
      const result = await importRevisionAction(s.language, s.id, item.id, kind, s.contentRevision ?? 0, selected, explanations);
      accept(result.session); showProposal(result.revision); await refreshHistory();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function saveConversion() {
    if (!word || busy || running) return;
    setBusy(true); setError(null);
    try {
      const s = await prepare(); if (!s) return;
      const result = await convertImportGrammar(s.language, s.id, word, s.contentRevision ?? 0, conversionKey.current);
      accept(result.session); setRevision(result.revision); await refreshHistory(); onCloseConversion();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const toggle = <T,>(array: T[], value: T) => array.includes(value) ? array.filter(v => v !== value) : [...array, value];
  const conversionSentence = all.find(s => s.index === conversion?.sentenceIndex);
  const chosen = all.filter(s => s.index >= Math.min(start, end) && s.index <= Math.max(start, end));
  return <section className="mb-4 rounded-xl border border-indigo-800 bg-gray-900 p-3" data-testid="import-revision-panel">
    <div className="flex flex-wrap items-center gap-2"><button ref={trigger} type="button" onClick={() => setOpen(v => !v)} className={button} aria-expanded={open}>{t('importReviseRange')}</button>
      <span role="status" className="text-xs text-gray-300">{running ? reconnecting ? t('importJobReconnecting') : t('importRevisionGenerating') : busy ? t('importSaving') : ''}</span></div>
    {error && <div role="alert" className="mt-3 space-y-2 break-words text-sm text-red-300"><p>{error}</p>{requestRef.current && !running && <button type="button" className={button} disabled={busy} onClick={() => void generate(requestRef.current?.kind === 'word-assist', true)}>{t('retry')}</button>}</div>}
    {open && <div className="mt-4 space-y-4">
      <fieldset disabled={busy || running} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-gray-300">{t('importRangeStart')}<select aria-label={t('importRangeStart')} className={control} value={start} onChange={e => { setStart(+e.target.value); requestRef.current = null; }}>{all.map((s, i) => <option key={s.index} value={s.index}>{i + 1}. {s.text.slice(0, 55)}</option>)}</select></label>
          <label className="text-sm text-gray-300">{t('importRangeEnd')}<select aria-label={t('importRangeEnd')} className={control} value={end} onChange={e => { setEnd(+e.target.value); requestRef.current = null; }}>{all.map((s, i) => <option key={s.index} value={s.index}>{i + 1}. {s.text.slice(0, 55)}</option>)}</select></label>
        </div>
        <div className="flex flex-wrap gap-2">{session.paragraphs.map((p, i) => p.sentences.length > 0 && <button key={i} type="button" className={button} onClick={() => { setStart(p.sentences[0].index); setEnd(p.sentences.at(-1)!.index); }}>{t('importSelectParagraph')} {i + 1}</button>)}</div>
        <div className="max-h-48 space-y-2 overflow-auto rounded-lg bg-indigo-950/40 p-3 text-sm text-gray-200">{chosen.map(s => <p key={s.index} data-selected-sentence={s.index}>{s.text}</p>)}</div>
        <label className="block text-sm text-gray-300">{t('importRevisionScope')}<select value={update} onChange={e => setUpdate(e.target.value as typeof update)} className={control}>
          <option value="both">{t('importReviseBoth')}</option><option value="explanation">{t('importReviseExplanation')}</option><option value="grammar">{t('importReviseGrammar')}</option></select></label>
        <label className="block text-sm text-gray-300">{t('importExplanationLanguage')}<select value={explanationLanguage} onChange={e => setExplanationLanguage(e.target.value)} className={control}><option value="ja">日本語</option><option value="en">English</option><option value="ko">한국어</option><option value="zh">中文</option></select></label>
        <label className="block text-sm text-gray-300">{t('importRevisionInstruction')}<textarea className={control} rows={3} value={instruction} onChange={e => { setInstruction(e.target.value); requestRef.current = null; }} maxLength={2000} /></label>
        <div className="flex flex-wrap gap-2">{(['importSimpler', 'importWhyMeaning', 'importLiteralDifference', 'importPreviousConnection'] as const).map(k => <button key={k} type="button" className={button} onClick={() => setInstruction(t(k))}>{t(k)}</button>)}</div>
        <p className="text-xs text-gray-400">{t('importRevisionContextHint')}</p>
        <button type="button" className={button} onClick={() => void generate()} disabled={!chosen.length}>{t('importGenerateProposal')}</button>
      </fieldset>
      {revision && <section className="space-y-3 border-t border-gray-700 pt-3" data-testid="import-revision-proposal">
        <p className="text-sm text-indigo-200">{t('importRevisionProposal')} · {t(revision.state === 'applied' ? 'importRevisionApplied' : revision.state === 'undone' ? 'importRevisionUndone' : revision.state === 'failed' ? 'importRevisionFailed' : revision.state === 'rejected' ? 'importRevisionRejected' : revision.state === 'proposed' ? 'importRevisionReady' : 'importRevisionGenerating')}</p>
        <details className="text-xs text-gray-400"><summary>{t('importRevisionContext')}</summary>{revision.context.map(c => <p key={c.sentenceIndex} className="mt-2">{c.text}</p>)}</details>
        {revision.state === 'proposed' && revision.kind !== 'word-assist' && <>
          {revision.changes.map(c => <label key={c.id} className="block rounded-lg border border-gray-700 p-3 text-sm"><input type="checkbox" disabled={busy} checked={selected.includes(c.id)} onChange={() => setSelected(v => toggle(v, c.id))} /> <strong className="text-indigo-200">{t(c.action === 'add' ? 'importRevisionAdd' : c.action === 'remove' ? 'importRevisionRemove' : 'importRevisionReplace')}</strong>
            <div className="mt-2 grid gap-3 sm:grid-cols-2"><div><p className="text-xs text-gray-400">{t('importRevisionBefore')}</p><p className="break-words text-gray-200">{c.before?.statement}</p><p className="whitespace-pre-wrap text-gray-400">{c.before?.description}</p></div><div><p className="text-xs text-gray-400">{t('importRevisionAfter')}</p><p className="break-words text-gray-200">{c.after?.statement}</p><p className="whitespace-pre-wrap text-gray-300">{c.after?.description}</p></div></div>
          </label>)}
          {revision.request.update !== 'grammar' && revision.sentences.map(s => <div key={s.index} className="rounded-lg border border-gray-700 p-3"><label className="text-sm text-indigo-200"><input type="checkbox" disabled={busy} checked={explanations.includes(s.index)} onChange={() => setExplanations(v => toggle(v, s.index))} /> {t('importAdoptExplanation')} · {s.text}</label><div className="mt-2 grid gap-3 sm:grid-cols-2"><div><p className="mb-1 text-xs text-gray-400">{t('importRevisionBefore')}</p><ImportComprehension reading={all.find(n => n.index === s.index)?.readingAnalysis} /></div><div><p className="mb-1 text-xs text-gray-400">{t('importRevisionAfter')}</p><ImportComprehension reading={s.readingAnalysis} /></div></div></div>)}
          <p className="text-xs text-gray-400">{t('importRevisionLibraryHint')}</p>
          <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || running || !selected.length && !explanations.length} onClick={() => void action('apply')}>{t('importApplyProposal')}</button><button type="button" className={button} disabled={busy || running} onClick={() => void action('reject')}>{t('importRejectProposal')}</button></div>
        </>}
      </section>}
      <details><summary className="cursor-pointer text-sm text-gray-300">{t('importRevisionHistory')}</summary><p className="my-2 text-xs text-gray-400">{t('importRevisionHistoryHint')}</p><ul className="space-y-3">{history.map(h => <li key={h.id} className="rounded-lg border border-gray-700 p-2 text-xs text-gray-300"><p>{h.createdAt} · {h.targets.map(t => t.sentenceIndex + 1).join(', ')}</p><p className="my-1 whitespace-pre-wrap">{h.request.instruction}</p><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || running} onClick={() => { setBusy(true); void getImportRevision(session.language, session.id, h.id).then(r => { showProposal(r); setInstruction(r.request.instruction); setStart(r.targets[0].sentenceIndex); setEnd(r.targets.at(-1)!.sentenceIndex); }).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>{t('importRevisionCompare')}</button>{h.state === 'applied' && <><button type="button" className={button} disabled={busy || running} onClick={() => void action('undo', h)}>{t('importUndo')}</button><button type="button" className={button} disabled={busy || running} onClick={() => void action('restore', h)}>{t('importRestoreProposal')}</button></>}</div></li>)}</ul></details>
    </div>}
    <dialog ref={dialog} aria-labelledby="import-conversion-title" onCancel={e => { if (running || busy) e.preventDefault(); else onCloseConversion(); }} className="m-auto max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-xl overflow-y-auto rounded-xl border border-gray-600 bg-gray-900 p-4 text-gray-100 backdrop:bg-black/60">
      <h3 id="import-conversion-title" className="mb-3 font-semibold">{t('importTreatAsWord')}</h3>
      {word && conversionSentence && <div className="space-y-3">
        <p className="text-sm text-gray-400">{conversion?.statement}</p>
        <p className="break-words text-lg leading-relaxed" data-testid="import-conversion-source">{conversionSentence.text.slice(0, word.start)}<mark className="bg-indigo-800 text-white">{conversionSentence.text.slice(word.start, word.end)}</mark>{conversionSentence.text.slice(word.end)}</p>
        <fieldset disabled={busy || running} className="space-y-3">
          <p className="text-xs text-gray-400">{t('importWordRangeHint')}</p>
          <div className="grid grid-cols-2 gap-3">{(['start', 'end'] as const).map(k => <label key={k} className="text-sm">{t(k === 'start' ? 'importWordStart' : 'importWordEnd')}<select aria-label={t(k === 'start' ? 'importWordStart' : 'importWordEnd')} className={control} value={word[k]} onChange={e => { const value = +e.target.value; const from = k === 'start' ? value : word.start, to = k === 'end' ? value : word.end; setWord({ ...word, [k]: value, term: conversionSentence.text.slice(from, to), meaning: '', transliteration: '' }); setAssisted(undefined); }}>{[...conversionSentence.text].map((ch, i, chars) => { const offset = chars.slice(0, i).join('').length + (k === 'end' ? ch.length : 0); return <option key={offset} value={offset}>{offset + (k === 'start' ? 1 : 0)}: {ch}</option>; })}</select></label>)}</div>
          {(['term', 'transliteration', 'meaning'] as const).map(k => <label key={k} className="block text-sm">{t(k === 'term' ? 'importWordLemma' : k === 'meaning' ? 'importContextMeaning' : 'importReading')}<input aria-label={t(k === 'term' ? 'importWordLemma' : k === 'meaning' ? 'importContextMeaning' : 'importReading')} className={control} value={word[k]} onChange={e => setWord({ ...word, [k]: e.target.value })} /></label>)}
          <label className="block text-sm">{t('importExplanationLanguage')}<select className={control} value={word.explanationLanguage} onChange={e => setWord({ ...word, explanationLanguage: e.target.value })}><option value="ja">日本語</option><option value="en">English</option><option value="ko">한국어</option><option value="zh">中文</option></select></label>
          <label className="block text-sm">{t('importConversionMode')}<select className={control} value={word.mode} onChange={e => setWord({ ...word, mode: e.target.value as typeof word.mode })}><option value="replace">{t('importConvertToWord')}</option><option value="add">{t('importAlsoAddWord')}</option></select></label>
          <p className="text-xs text-gray-400">{t('importConversionLibraryHint')}</p>
          {(() => { const duplicate = session.items.find(i => i.kind === 'word' && !i.hiddenByRevision && i.status !== 'skipped' && !i.suppressedByGrammar && i.sentenceIndex === conversionSentence.index && i.range?.start === word.start && i.range.end === word.end); return duplicate ? <p role="status" className="text-sm text-amber-200">{t('importConversionDuplicate')}</p> : null; })()}
          <button type="button" className={button} onClick={() => void generate(true)} disabled={word.end <= word.start || !word.term.trim()}>{t('importAssistWord')}</button>
        </fieldset>
        {assisted && <div className="rounded-lg border border-indigo-600 p-3 text-sm"><p>{assisted.term} · {assisted.transliteration}</p><p>{assisted.meaning}</p><button type="button" className={`${button} mt-2`} disabled={running || busy} onClick={() => { setWord({ ...word, ...assisted }); setAssisted(undefined); }}>{t('importUseWordSuggestion')}</button></div>}
        {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
        <p role="status" className="text-xs text-indigo-200">{running ? t('importRevisionGenerating') : ''}</p>
        <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-gray-700 bg-gray-900 py-2"><button type="button" className={button} disabled={busy || running || word.end <= word.start || !word.term.trim()} onClick={() => void saveConversion()}>{t('importSaveWordCandidate')}</button><button type="button" className={button} disabled={busy || running} onClick={onCloseConversion}>{t('cancel')}</button></div>
      </div>}
    </dialog>
  </section>;
}
