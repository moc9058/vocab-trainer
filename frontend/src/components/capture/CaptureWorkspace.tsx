import { useCaptureNavigationBlocker } from '../../hooks/useCaptureNavigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/context';
import { NativeCapture, pendingCaptureRequest, type CaptureDraft, type NativeCapturePlugin, type LocalCapture } from '../../platform/capture';
import { captureTextKind, draftFromOperation, emptyCaptureDraft, validCaptureUrl } from '../../utils/captureInput';
import type { TranslationKey } from '../../i18n/translations';
import type { ImportSourceOrigin } from '../../types';
import CaptureImage from './CaptureImage';

export interface CaptureSelection { capture: LocalCapture; blockId: string; blockIds: string[]; text: string; origin: ImportSourceOrigin; draft: CaptureDraft }

export default function CaptureWorkspace({ captureId, launchId, sourceUrl, onConfirm, onResume, onClose, renderOptions, source = NativeCapture }: {
  source?: NativeCapturePlugin; captureId?: string; launchId?: string; sourceUrl?: string;
  onConfirm: (selection: CaptureSelection) => void | Promise<void>;
  onResume: (capture: LocalCapture, blockId: string) => void | Promise<void>; onClose: () => void;
  renderOptions?: (draft: CaptureDraft, update: (patch: Partial<CaptureDraft>) => void) => ReactNode;
}) {
  const { t } = useI18n();
  const [capture, setCapture] = useState<LocalCapture | null>(null);
  const [draft, setDraft] = useState<CaptureDraft>(emptyCaptureDraft);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const currentCapture = useRef<Promise<LocalCapture> | null>(null);
  const captureByGeneration = useRef(new Map<number, Promise<LocalCapture>>());
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef<{ draft: CaptureDraft; capture: Promise<LocalCapture> | null; generation: number } | null>(null);
  const discarded = useRef(false);
  const blockId = draft.blockId ?? (draft.selected.join('_') || 'text');
  const previous = capture?.operations[blockId];
  const update = (patch: Partial<CaptureDraft>) => setDraft(value => ({ ...value, ...patch }));
  const report = (err: unknown) => {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : err instanceof Error ? err.message : '';
    const keys: Record<string, TranslationKey> = { chineseUnavailable: 'captureChineseUnavailable', full: 'captureFull', expired: 'captureExpired', CAPTURE_EXPIRED: 'captureExpired', locked: 'captureLocked', CAPTURE_LOCKED: 'captureLocked', tooLong: 'captureTooLong' };
    setError(t(keys[code] ?? 'captureLoadError'));
  };

  // All writes, including unmount flushes, are ordered. Never save one capture's
  // late draft into the next capture when the user switches inputs quickly.
  function persist(snapshot: NonNullable<typeof latest.current>): Promise<LocalCapture | undefined> {
    const task = writes.current.catch(() => {}).then(async () => {
      let value: LocalCapture;
      snapshot.capture ??= captureByGeneration.current.get(snapshot.generation) ?? null;
      if (snapshot.capture) value = await snapshot.capture;
      else {
        if (captureTextKind(snapshot.draft.text) !== 'text') return;
        const received = source.receiveText({ text: snapshot.draft.text });
        snapshot.capture = received;
        captureByGeneration.current.set(snapshot.generation, received);
        if (snapshot.generation === generation.current) currentCapture.current = received;
        try { value = await received; }
        catch (err) {
          captureByGeneration.current.delete(snapshot.generation);
          if (snapshot.generation === generation.current && currentCapture.current === received) currentCapture.current = null;
          snapshot.capture = null;
          throw err;
        }
      }
      await source.saveDraft({ id: value.id, draft: snapshot.draft });
      await source.acknowledge({ id: value.id });
      if (mounted.current && snapshot.generation === generation.current) {
        setCapture(old => old?.id === value.id ? { ...old, draft: snapshot.draft } : { ...value, draft: snapshot.draft });
        setSaveError(false);
      }
      return value;
    });
    writes.current = task;
    void task.catch(() => { if (mounted.current && snapshot.generation === generation.current) setSaveError(true); });
    return task;
  }

  async function load(id?: string) {
    const current = ++generation.current;
    setReady(false); setBusy(!!id); setError(''); setSaveError(false); setCapture(null);
    setDraft({ ...emptyCaptureDraft(), sourceUrl: sourceUrl ?? '' });
    latest.current = null; currentCapture.current = null; discarded.current = false;
    try {
      if (id) {
        let value = await source.load({ id });
        if (current !== generation.current) return;
        setCapture(value);
        if (value.inputKind === 'image') value = { ...value, ...(await source.recognize({ id })) };
        if (current !== generation.current) return;
        currentCapture.current = Promise.resolve(value);
        captureByGeneration.current.set(current, currentCapture.current);
        setCapture(value);
        let restored = value.draft ?? { ...emptyCaptureDraft(), text: value.text ?? '' };
        const key = restored.blockId ?? (restored.selected.join('_') || 'text');
        if (value.operations[key]) restored = draftFromOperation(value.operations[key], restored, pendingCaptureRequest);
        setDraft(restored);
        await source.acknowledge({ id });
      } else if (launchId) await source.acknowledgeLaunch({ id: launchId });
      if (current === generation.current) setReady(true);
    } catch (err) { if (current === generation.current) report(err); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void load(captureId);
    return () => {
      mounted.current = false;
      const snapshot = latest.current;
      if (snapshot && !discarded.current) void persist(snapshot).catch(() => {});
      generation.current++;
    };
  }, [captureId, launchId]);
  useEffect(() => {
    if (!ready) return;
    const snapshot = { draft, capture: currentCapture.current, generation: generation.current };
    latest.current = snapshot;
    const timer = setTimeout(() => {
      // Another draft may have created a text capture during this debounce.
      snapshot.capture = currentCapture.current;
      void persist(snapshot).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, ready]);

  async function pick() {
    setError('');
    try {
      if (latest.current) await persist({ ...latest.current, capture: currentCapture.current });
      const result = await source.pickImage();
      if (result.id) await load(result.id);
    } catch (err) { report(err); }
  }
  function choose(ids: string[]) {
    if (!capture) return;
    const ordered = (capture.blocks ?? []).filter(b => ids.includes(b.id));
    const next = { ...draft, selected: ordered.map(b => b.id), blockId: undefined, text: ordered.map(b => b.text).join('\n') };
    const operation = capture.operations[next.selected.join('_') || 'text'];
    try { setDraft(operation ? draftFromOperation(operation, next, pendingCaptureRequest) : next); }
    catch (err) { report(err); }
  }
  async function confirm() {
    if (busy || !ready || captureTextKind(draft.text) !== 'text' || !validCaptureUrl(draft.sourceUrl)) return;
    setBusy(true); setError('');
    try {
      const value = await persist({ draft, capture: currentCapture.current, generation: generation.current });
      if (!value) return;
      const selection: CaptureSelection = { capture: value, blockId, blockIds: draft.selected, text: draft.text, draft,
        origin: { version: 1, method: value.method, sourceKind: draft.sourceKind, textConfirmed: true, capturedAt: value.receivedAt,
          ...(draft.sourceLabel.trim() ? { sourceLabel: draft.sourceLabel.trim() } : {}), ...(draft.sourceUrl ? { sourceUrl: draft.sourceUrl } : {}) } };
      await onConfirm(selection);
      // A lost response may have frozen a request even though analysis did not open.
      if (mounted.current) await load(value.id);
    } catch (err) { if (mounted.current) report(err); }
    finally { if (mounted.current) setBusy(false); }
  }
  useCaptureNavigationBlocker(busy || saveError);
  const kind = captureTextKind(draft.text);
  return <section className="mx-auto max-w-4xl space-y-5 px-3 py-4 text-gray-100 sm:p-6" data-testid="capture-workspace">
    <header className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{t('captureTitle')}</h2><p className="mt-1 text-sm text-gray-400">{t('captureIntro')}</p></div><button type="button" disabled={busy} onClick={async () => {
      try { if (latest.current) await persist({ ...latest.current, capture: currentCapture.current }); onClose(); } catch { setSaveError(true); }
    }} className="min-h-11 shrink-0 rounded border border-gray-700 px-3">{t('cancel')}</button></header>
    <details className="rounded-xl border border-gray-700 p-3 text-sm leading-relaxed text-gray-300"><summary className="cursor-pointer font-medium text-indigo-200">{t('captureSetup')}</summary><ol className="mt-3 list-decimal space-y-2 pl-5"><li>{t('captureSetupScreenshot')}</li><li>{t('captureSetupIntent')}</li><li>{t('captureSetupControl')}</li></ol><p className="mt-3">{t('captureSetupText')}</p><p className="mt-3">{t('captureSetupFallback')}</p></details>
    {!capture && <p className="rounded-xl border border-indigo-800 p-3 text-sm leading-relaxed">{t('captureInputRequired')}</p>}
    {busy && <p role="status">{t(capture?.inputKind === 'image' && !ready ? 'captureRecognizing' : 'captureWorking')}</p>}
    {error && <div role="alert" className="rounded-xl border border-red-800 p-3 text-red-200"><p>{error}</p><button type="button" onClick={() => void load(capture?.id ?? captureId)} className="mt-2 min-h-11 underline">{t('retry')}</button></div>}
    {saveError && <p role="alert" className="text-red-300">{t('captureDraftError')} <button onClick={() => { if (latest.current) void persist({ ...latest.current, capture: currentCapture.current }).catch(() => {}); }} className="min-h-11 underline">{t('retry')}</button></p>}
    {capture && <>
      <p className="text-xs text-gray-400">{t('captureReceivedAt')}: {new Date(capture.receivedAt).toLocaleString()}</p>
      <CaptureImage capture={capture} selected={draft.selected} onChoose={id => { if (!busy) choose([id]); }} />
      {!busy && capture.inputKind === 'image' && !capture.blocks?.length && <p className="text-amber-200">{t('captureNoText')}</p>}
      {!!capture.blocks?.length && <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-sm text-gray-300">{t('captureSelectionHint')}</legend>{capture.blocks.map((block, index) => <label key={block.id} className="flex min-h-11 items-start gap-3 rounded-lg bg-gray-800 p-3 text-sm"><input type="checkbox" className="mt-1" checked={draft.selected.includes(block.id)} onChange={e => choose(e.target.checked ? [...draft.selected, block.id] : draft.selected.filter(id => id !== block.id))} /><span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{index + 1}. {block.text}{block.confidence < .7 && <span className="block text-xs text-amber-200">{t('captureLowConfidence')}</span>}</span></label>)}</fieldset>}
    </>}
    {draft.selected.length > 1 && <p className="text-sm text-amber-200">{t('captureMergeHint')}</p>}
    <fieldset disabled={busy || !!previous || !ready} className="space-y-4">
      <label className="block text-sm">{t('captureConfirmText')}<textarea value={draft.text} onChange={e => update({ text: e.target.value })} rows={6} placeholder={t('capturePasteHint')} className="mt-2 w-full rounded-xl border border-gray-600 bg-gray-800 p-3 text-base leading-relaxed disabled:opacity-70" /></label>
      <p className={draft.text.length > 8000 ? 'text-sm text-red-300' : 'text-xs text-gray-400'}>{draft.text.length} / 8000 · {t('captureTextLimit')}</p>
      {(kind === 'url' || (!draft.text && !!sourceUrl)) && <p role="status" className="text-amber-200">{t('captureUrlOnly')}</p>}
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">{t('captureSourceLabel')}<input value={draft.sourceLabel} maxLength={100} onChange={e => update({ sourceLabel: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-base" /></label>
      <label className="text-sm">{t('captureSourceKind')}<select aria-label={t('captureSourceKind')} value={draft.sourceKind} onChange={e => update({ sourceKind: e.target.value as ImportSourceOrigin['sourceKind'] })} className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-base">{(['unknown', 'post', 'comment', 'article'] as const).map(value => <option key={value} value={value}>{t(value === 'unknown' ? 'captureKindUnknown' : value === 'post' ? 'captureKindPost' : value === 'comment' ? 'captureKindComment' : 'captureKindArticle')}</option>)}</select></label></div>
      <label className="block text-sm">{t('captureSourceUrl')}<input value={draft.sourceUrl} maxLength={2048} type="url" onChange={e => update({ sourceUrl: e.target.value })} placeholder="https://" className="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-base" /></label>
      {renderOptions?.(draft, update)}
    </fieldset>
    <p className="text-sm leading-relaxed text-gray-400">{t('capturePrivacy')}</p>
    <p className="text-sm leading-relaxed text-gray-400">{t('captureSendHint')}</p>
    {previous ? <button type="button" disabled={busy} onClick={() => void onResume(capture!, blockId)} className="min-h-11 rounded-xl bg-indigo-600 px-5 py-3">{t('captureResumeSource')}</button> : <button type="button" disabled={busy || !ready || kind !== 'text' || !validCaptureUrl(draft.sourceUrl) || (capture?.inputKind === 'image' && !draft.selected.length)} onClick={() => void confirm()} className="min-h-11 rounded-xl bg-indigo-600 px-5 py-3 font-medium disabled:opacity-40">{t('importAnalyze')}</button>}
    {previous && <button type="button" disabled={busy} className="ml-3 min-h-11 rounded-lg border border-indigo-700 px-3 text-sm" onClick={() => update({ blockId: `${draft.selected.join('_') || 'text'}:${crypto.randomUUID()}` })}>{t('captureStartAgain')}</button>}
    <details className="rounded-xl border border-gray-700 p-3"><summary className="min-h-8 cursor-pointer text-indigo-200">{t('captureOtherInput')}</summary><p className="my-3 text-sm text-gray-400">{t('captureInputRequired')}</p><button type="button" disabled={busy} onClick={() => void pick()} className="min-h-11 rounded-lg border border-indigo-700 px-4">{t('capturePickImage')}</button><button type="button" disabled={busy} onClick={async () => {
      try { if (latest.current) await persist({ ...latest.current, capture: currentCapture.current }); await load(); } catch (err) { report(err); }
    }} className="ml-3 min-h-11 rounded-lg border border-indigo-700 px-4">{t('captureEnterText')}</button></details>
    {capture && <button type="button" disabled={busy} onClick={async () => {
      if (!window.confirm(t('captureDiscardConfirm'))) return;
      try {
        discarded.current = true;
        await writes.current.catch(() => {});
        await source.discard({ id: capture.id });
        latest.current = null; setCapture(null); onClose();
      } catch (err) { discarded.current = false; report(err); }
    }} className="min-h-11 px-3 text-sm text-red-300">{t('captureDiscard')}</button>}
  </section>;
}
