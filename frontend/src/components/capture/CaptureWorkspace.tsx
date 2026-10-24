import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/context';
import { NativeCapture, pendingCaptureRequest, type NativeCapturePlugin, type LocalCapture } from '../../platform/capture';
import type { ImportSourceOrigin } from '../../types';
import CaptureImage from './CaptureImage';

export interface CaptureSelection { capture: LocalCapture; blockId: string; blockIds: string[]; text: string; origin: ImportSourceOrigin }

export default function CaptureWorkspace({ captureId, onConfirm, onResume, onClose, source = NativeCapture }: {
  source?: NativeCapturePlugin; captureId?: string; onConfirm: (selection: CaptureSelection) => void;
  onResume: (capture: LocalCapture, blockId: string) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [capture, setCapture] = useState<LocalCapture | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('小红书');
  const [sourceKind, setSourceKind] = useState<ImportSourceOrigin['sourceKind']>('unknown');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const [newKey, setNewKey] = useState<string | null>(null);
  const blockId = newKey ?? (selected.join('_') || 'text');
  const previous = capture?.operations[blockId];
  async function load(id: string) {
    const current = ++generation.current;
    setBusy(true); setError(false); setCapture(null); setSelected([]); setText('');
    try {
      let value = await source.load({ id });
      if (current !== generation.current) return;
      setCapture(value);
      if (value.inputKind === 'image') value = { ...value, ...(await source.recognize({ id })) };
      if (current !== generation.current) return;
      setCapture(value);
      if (value.operations.text) setText(pendingCaptureRequest(value.operations.text).text);
      else setText(value.text ?? '');
      await source.acknowledge({ id });
    } catch { if (current === generation.current) setError(true); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => { if (captureId) void load(captureId); return () => { generation.current++; }; }, [captureId]);
  async function pick() {
    setError(false);
    try { const result = await source.pickImage(); if (result.id) await load(result.id); }
    catch { setError(true); }
  }
  function choose(ids: string[]) {
    if (!capture) return;
    // Keep the actual screen reading order, independent of checkbox click order.
    const ordered = (capture.blocks ?? []).filter(b => ids.includes(b.id));
    const idsInOrder = ordered.map(b => b.id);
    setSelected(idsInOrder); setNewKey(null);
    const previous = capture.operations[idsInOrder.join('_') || 'text'];
    if (previous) {
      try {
        const input = pendingCaptureRequest(previous);
        setText(input.text); setLabel(input.sourceOrigin?.sourceLabel ?? ''); setUrl(input.sourceOrigin?.sourceUrl ?? ''); setSourceKind(input.sourceOrigin?.sourceKind ?? 'unknown');
      } catch { setError(true); }
    } else setText(ordered.map(b => b.text).join('\n'));
  }
  const validUrl = !url || (() => { try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } })();
  return <section className="mx-auto max-w-4xl space-y-5 px-3 py-4 text-gray-100 sm:p-6" data-testid="capture-workspace">
    <header className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{t('captureTitle')}</h2><p className="mt-1 text-sm text-gray-400">{t('captureIntro')}</p></div><button type="button" onClick={onClose} className="min-h-11 shrink-0 rounded border border-gray-700 px-3">{t('cancel')}</button></header>
    <details className="rounded-xl border border-gray-700 p-3 text-sm leading-relaxed text-gray-300"><summary className="cursor-pointer font-medium text-indigo-200">{t('captureSetup')}</summary><ol className="mt-3 list-decimal space-y-2 pl-5"><li>{t('captureSetupScreenshot')}</li><li>{t('captureSetupIntent')}</li><li>{t('captureSetupControl')}</li></ol><p className="mt-3">{t('captureSetupFallback')}</p></details>
    <button type="button" disabled={busy} onClick={() => void pick()} className="min-h-11 rounded-lg bg-indigo-600 px-4 disabled:opacity-40">{t('capturePickImage')}</button>
    {busy && <p role="status">{t('captureRecognizing')}</p>}
    {error && <div role="alert" className="rounded-xl border border-red-800 p-3 text-red-200"><p>{t('captureLoadError')}</p>{captureId && <button type="button" onClick={() => void load(captureId)} className="mt-2 min-h-11 underline">{t('retry')}</button>}</div>}
    {capture && <>
      <p className="text-xs text-gray-400">{t('captureReceivedAt')}: {new Date(capture.receivedAt).toLocaleString()}</p>
      <CaptureImage capture={capture} selected={selected} onChoose={id => choose([id])} />
      {!busy && capture.inputKind === 'image' && !capture.blocks?.length && <p className="text-amber-200">{t('captureNoText')}</p>}
      {!!capture.blocks?.length && <fieldset className="space-y-2"><legend className="mb-2 text-sm text-gray-300">{t('captureSelectionHint')}</legend>{capture.blocks.map((block, index) => <label key={block.id} className="flex min-h-11 items-start gap-3 rounded-lg bg-gray-800 p-3 text-sm"><input type="checkbox" className="mt-1" checked={selected.includes(block.id)} onChange={e => choose(e.target.checked ? [...selected, block.id] : selected.filter(id => id !== block.id))} /><span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{index + 1}. {block.text}{block.confidence < .7 && <span className="block text-xs text-amber-200">{t('captureLowConfidence')}</span>}</span></label>)}</fieldset>}
      {selected.length > 1 && <p className="text-sm text-amber-200">{t('captureMergeHint')}</p>}
      <label className="block text-sm">{t('captureConfirmText')}<textarea value={text} disabled={!!previous} onChange={e => setText(e.target.value)} rows={6} className="mt-2 w-full rounded-xl border border-gray-600 bg-gray-800 p-3 text-base leading-relaxed disabled:opacity-70" /></label>
      <p className={text.length > 8000 ? 'text-sm text-red-300' : 'text-xs text-gray-400'}>{text.length} / 8000 · {t('captureTextLimit')}</p>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{t('captureSourceLabel')}<input value={label} maxLength={100} disabled={!!previous} onChange={e => setLabel(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-base" /></label>
      <label className="text-sm">{t('captureSourceKind')}<select aria-label={t("captureSourceKind")} value={sourceKind} disabled={!!previous} onChange={e => setSourceKind(e.target.value as ImportSourceOrigin['sourceKind'])} className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-base">{(['unknown', 'post', 'comment', 'article'] as const).map(kind => <option key={kind} value={kind}>{t(kind === 'unknown' ? 'captureKindUnknown' : kind === 'post' ? 'captureKindPost' : kind === 'comment' ? 'captureKindComment' : 'captureKindArticle')}</option>)}</select></label></div>
      <label className="block text-sm">{t('captureSourceUrl')}<input value={url} disabled={!!previous} maxLength={2048} type="url" onChange={e => setUrl(e.target.value)} placeholder="https://" className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-base" /></label>
      <p className="text-sm leading-relaxed text-gray-400">{t('capturePrivacy')}</p>
      {previous ? <button type="button" disabled={busy} onClick={() => onResume(capture, blockId)} className="min-h-11 rounded-xl bg-indigo-600 px-5 py-3">{t('captureResumeSource')}</button> : <button type="button" disabled={busy || !text.trim() || text.length > 8000 || !validUrl || (capture.inputKind === 'image' && !selected.length)} onClick={() => onConfirm({ capture, blockId, blockIds: selected, text, origin: { version: 1, method: capture.method, sourceKind, textConfirmed: true, capturedAt: capture.receivedAt, ...(label.trim() ? { sourceLabel: label.trim() } : {}), ...(url ? { sourceUrl: url } : {}) } })} className="min-h-11 rounded-xl bg-indigo-600 px-5 py-3 font-medium disabled:opacity-40">{t('captureUseText')}</button>}
      {previous && <button type="button" className="ml-3 min-h-11 rounded-lg border border-indigo-700 px-3 text-sm" onClick={() => setNewKey(`${selected.join('_') || 'text'}:${crypto.randomUUID()}`)}>{t('captureStartAgain')}</button>}
      <button type="button" disabled={busy} onClick={async () => { if (!window.confirm(t('captureDiscardConfirm'))) return; try { await source.discard({ id: capture.id }); setCapture(null); onClose(); } catch { setError(true); } }} className="ml-3 min-h-11 px-3 text-sm text-red-300">{t('captureDiscard')}</button>
    </>}
  </section>;
}
