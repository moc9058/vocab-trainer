import type { ImportItem, ImportReadingAnalysis, ImportSentence } from '../../types';
import { useI18n } from '../../i18n/context';
import { validateMeaningUnits } from '../../utils/importMeaningUnits';
import { projectMeaningUnitDetails } from '../../utils/importMeaningUnitDetails';

export default function ImportMeaningUnits({ reading, sentence, items = [], onWord, onConstruction }: {
  reading: ImportReadingAnalysis; sentence?: ImportSentence; items?: ImportItem[];
  onWord?: (id: string) => void; onConstruction?: (id: string) => void;
}) {
  const { t } = useI18n();
  const value = reading.comprehension?.meaningUnits;
  if (!value || !validateMeaningUnits(reading.sourceText, value)) return null;
  const details = sentence ? projectMeaningUnitDetails(sentence, items) : [];
  return <section className="space-y-3" data-testid="import-meaning-units">
    <h4 className="font-semibold text-indigo-200">{t('importMeaningUnits')}</h4>
    <ol className="space-y-3">{value.units.map((unit, i) => <li key={`${unit.range.start}-${unit.range.end}`} className="min-w-0 rounded-lg border border-indigo-800/70 bg-gray-900/50 p-3">
      <p className="whitespace-pre-wrap break-words font-medium text-gray-100">{i + 1}. {unit.text}</p>
      <p className="mt-2 whitespace-pre-wrap break-words text-indigo-100">{unit.meaning}</p>
      <p className="mt-1 text-xs text-gray-400">{t('importMeaningUnitRole')}: {unit.role}</p>
      {onWord && !!details[i]?.words.length && <div className="mt-3 flex flex-wrap gap-2" aria-label={t('importReaderWord')}>{details[i].words.map(word => <button type="button" key={word.id} aria-label={`${word.surface}${word.transliteration ? ` ${word.transliteration}` : ""}`} onClick={() => onWord(word.id)} className="min-h-11 rounded-lg border border-indigo-700 px-3 py-2 text-left text-indigo-200"><span>{word.surface}</span>{word.transliteration && <span className="ml-2 text-xs">{word.transliteration}</span>}</button>)}</div>}
      {onConstruction && !!details[i]?.constructions.length && <div className="mt-2 space-y-2">{details[i].constructions.map(({ point, crossesUnits }) => <button type="button" key={point.id} onClick={() => onConstruction(point.id)} className="block min-h-11 w-full rounded-lg border border-emerald-800 px-3 py-2 text-left text-emerald-200">{point.statement}{crossesUnits && <span className="mt-1 block text-xs text-gray-400">{t('importAcrossMeaningUnits')}</span>}</button>)}</div>}
    </li>)}</ol>
    <div><h5 className="font-medium text-indigo-200">{t('importMeaningUnitsFlow')}</h5><p className="mt-1 whitespace-pre-wrap break-words">{value.flow}</p></div>
  </section>;
}
