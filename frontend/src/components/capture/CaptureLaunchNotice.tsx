import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCaptureInbox } from '../../hooks/useCaptureInbox';
import { useI18n } from '../../i18n/context';
import { useAnswerOutbox } from '../../hooks/useAnswerOutbox';

/** Never replace an active quiz or unsaved article when an intent arrives. */
export default function CaptureLaunchNotice() {
  const { captures } = useCaptureInbox();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const outbox = useAnswerOutbox();
  const pending = captures.find(c => !c.acknowledged);
  const target = pending ? `/chinese/import?capture=${encodeURIComponent(pending.id)}` : '';
  useEffect(() => {
    if (target && !outbox.pending && /^\/(?:chinese\/?)?$/.test(location.pathname)) navigate(target);
  }, [target, outbox.pending, location.pathname, navigate]);
  if (!pending || location.search.includes(encodeURIComponent(pending.id))) return null;
  return <div className="sticky top-0 z-30 flex flex-wrap items-center justify-center gap-3 border-b border-indigo-700 bg-indigo-950 px-4 py-3 text-sm text-indigo-100">
    <span>{t('captureReceived')}</span>
    <button type="button" disabled={!!outbox.pending} onClick={() => navigate(target)} className="min-h-11 rounded-lg bg-indigo-600 px-4 disabled:opacity-50">{t('captureOpen')}</button>
    {!!outbox.pending && <span>{t('captureWaitForSync')}</span>}
  </div>;
}
