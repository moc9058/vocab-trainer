import { useCaptureNavigationBlocked } from '../../hooks/useCaptureNavigation';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCaptureInbox } from '../../hooks/useCaptureInbox';
import { useI18n } from '../../i18n/context';
import { useAnswerOutbox } from '../../hooks/useAnswerOutbox';

/** Never replace an active quiz or unsaved article when an intent arrives. */
export default function CaptureLaunchNotice() {
  const { captures, launches } = useCaptureInbox();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const outbox = useAnswerOutbox();
  const blocked = useCaptureNavigationBlocked();
  const pending = captures.find(c => !c.acknowledged);
  const launch = launches.find(l => !l.acknowledged);
  const latest = pending && launch ? (pending.receivedAt >= launch.receivedAt ? 'capture' : 'readingInput') : pending ? 'capture' : 'readingInput';
  const id = latest === 'capture' ? pending?.id : launch?.id;
  const target = id ? `/chinese/import?${latest}=${encodeURIComponent(id)}` : '';
  const waiting = !!outbox.pending || blocked;
  useEffect(() => {
    if (target && !waiting && /^\/(?:chinese\/?)?$/.test(location.pathname)) navigate(target);
  }, [target, waiting, location.pathname, navigate]);
  if (!id || location.search.includes(encodeURIComponent(id))) return null;
  return <div className="sticky top-0 z-30 flex flex-wrap items-center justify-center gap-3 border-b border-indigo-700 bg-indigo-950 px-4 py-3 text-sm text-indigo-100">
    <span>{t('captureReceived')}</span>
    <button type="button" disabled={waiting} onClick={() => {
      if (!/^\/(?:chinese\/?)?$/.test(location.pathname) && !window.confirm(t('captureLeaveConfirm'))) return;
      navigate(target);
    }} className="min-h-11 rounded-lg bg-indigo-600 px-4 disabled:opacity-50">{t('captureOpen')}</button>
    {waiting && <span>{t(outbox.pending ? 'captureWaitForSync' : 'captureWaitForWork')}</span>}
  </div>;
}
