import ImportMeaningUnits from './ImportMeaningUnits';
import type { ImportReadingAnalysis, ImportSentence, ImportItem } from '../../types';
import { useI18n } from '../../i18n/context';

export default function ImportComprehension({ reading, sentence, items, onWord, onConstruction }: {
  reading?: ImportReadingAnalysis; sentence?: ImportSentence; items?: ImportItem[];
  onWord?: (id: string) => void; onConstruction?: (id: string) => void;
}) {
  const { t } = useI18n();
  if (!reading) return null;
  const c = reading.comprehension;
  return <section className="mb-4 space-y-3 rounded-xl border border-indigo-800/70 bg-indigo-950/30 p-3 text-sm leading-relaxed" data-testid="import-comprehension">
    <div><h4 className="mb-1 font-semibold text-indigo-200">{t('importWholeMeaning')}</h4><p className="whitespace-pre-wrap text-gray-100">{c?.meaning || reading.overview || t('importNoContextMeaning')}</p></div>
    <ImportMeaningUnits reading={reading} sentence={sentence} items={items} onWord={onWord} onConstruction={onConstruction} />
    {c && <details><summary className="cursor-pointer text-indigo-200">{t('importMeaningDetails')}</summary><div className="mt-3 space-y-3">
      {([[t('importSentenceSkeleton'), c.skeleton], [t('importContextConnection'), c.connection]]).map(([label, value]) => value && <div key={label}><h5 className="font-semibold text-gray-300">{label}</h5><p className="whitespace-pre-wrap text-gray-200">{value}</p></div>)}
      {c.nuances.length > 0 && <div><h5 className="font-semibold text-gray-300">{t('importNuance')}</h5>{c.nuances.map((n, i) => <p key={i} className="mt-2 text-gray-200">{n.text}<br /><span className="text-xs text-gray-400">「{n.evidence}」 · {t(n.certainty === 'explicit' ? 'importExplicitMeaning' : n.certainty === 'inferred' ? 'importInferredMeaning' : 'importUncertainMeaning')}</span></p>)}</div>}
    </div></details>}
    {reading.ambiguityNotes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-amber-200">{reading.ambiguityNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
  </section>;
}
