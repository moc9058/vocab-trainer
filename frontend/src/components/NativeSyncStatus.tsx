import { useAnswerOutbox } from '../hooks/useAnswerOutbox';
import { useI18n } from '../i18n/context';
import { isNative } from '../platform/native';
export default function NativeSyncStatus() {
  const outbox = useAnswerOutbox(); const { t } = useI18n();
  if (!isNative() || (!outbox.pending && !outbox.failed)) return null;
  return <div role="status" className="native-sync-status bg-amber-950 px-3 py-2 text-center text-xs text-amber-100">
    {outbox.pending > 0 && <><button onClick={outbox.flush}>{t('unsyncedAnswers').replace('{n}', String(outbox.pending))}</button> · {t(outbox.authBlocked ? 'syncNeedsLogin' : 'nativeSyncWarning')}</>}
    {outbox.failed > 0 && <button onClick={outbox.acknowledgeFailed}>{t('unsyncableAnswers').replace('{n}', String(outbox.failed))}</button>}
  </div>;
}
