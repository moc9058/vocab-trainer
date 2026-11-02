import { useI18n } from '../../i18n/context';
import { importWordIssues } from '../../utils/importWordRepair';
import type { ImportItem, ImportSentence, ImportWordItem } from '../../types';

export default function ImportReadingWarnings({ sentence, items, language, onAssist, locked }: {
  sentence: ImportSentence; items: ImportItem[]; language: string;
  onAssist?: (word: ImportWordItem) => void; locked?: boolean;
}) {
  const { t } = useI18n();
  const issues = language === 'chinese' ? importWordIssues(sentence, items) : [];
  if (!issues.length) return null;
  return <div role="status" className="my-3 rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-sm text-amber-100" data-testid="import-reading-warnings">
    <p>{t('importReadingIncomplete')} ({sentence.index + 1})</p>
    <ul className="mt-2 flex flex-wrap gap-2">{issues.map(({ word, position }) => <li key={word.id}>
      <button type="button" disabled={locked || word.status === 'queued' || !onAssist}
        className="rounded border border-amber-600 px-2 py-1 text-left disabled:opacity-50" onClick={() => onAssist?.(word)}>
        {word.term} · {t(position ? 'importWordPositionIssue' : 'importRepairReading')}
      </button>
    </li>)}</ul>
  </div>;
}
