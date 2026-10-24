import type { ImportItem, ImportSentence, ImportTextRange } from '../types';
import { readingConstructions, readingOccurrences, validReading } from './importReadingAnalysis';
import { validateMeaningUnits } from './importMeaningUnits';

const intersects = (a: ImportTextRange, b: ImportTextRange) => a.start < b.end && a.end > b.start;
export function projectMeaningUnitDetails(sentence: ImportSentence, items: ImportItem[]) {
  const reading = validReading(sentence), meaning = reading?.comprehension?.meaningUnits;
  if (!meaning || !validateMeaningUnits(sentence.text, meaning)) return [];
  const words = readingOccurrences(sentence, items), constructions = readingConstructions(sentence, items);
  return meaning.units.map(unit => ({
    unit,
    words: words.filter(w => intersects(unit.range, w.range)),
    constructions: constructions.filter(c => c.ranges.some(r => intersects(unit.range, r))).map(point => ({
      point,
      crossesUnits: meaning.units.filter(u => point.ranges.some(r => intersects(u.range, r))).length > 1,
    })),
  }));
}
