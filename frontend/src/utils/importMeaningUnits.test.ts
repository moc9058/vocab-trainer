import { test, expect } from 'vitest';
import { normalizeMeaningUnits, validateMeaningUnits } from './importMeaningUnits';
import { projectMeaningUnitDetails } from './importMeaningUnitDetails';
import { captureButtonPosition, validCaptureRect } from './captureGeometry';
import { pendingCaptureRequest } from '../platform/capture';
import type { ImportSentence } from '../types';

test('meaning units and occurrence projection retain repeated words and a crossing construction', () => {
  const text = '虽然如此，但他还是来了。';
  const meaningUnits = normalizeMeaningUnits(text, { units: [{ text: '虽然如此，', meaning: 'そうではあるが', role: '譲歩' }, { text: '但他还是来了。', meaning: '彼は来た', role: '結論' }], flow: '譲歩から結論へ' });
  const sentence: ImportSentence = { index: 0, text, readingAnalysis: { version: 1, sourceText: text, explanationLanguage: 'ja', overview: '', ambiguityNotes: [], comprehension: { meaning: '', skeleton: '', connection: '', nuances: [], meaningUnits },
    occurrences: [{ id: 'first', range: { start: 0, end: 2 }, surface: '虽然', lemma: '虽然', contextualMeaning: '', explanationLanguage: 'ja', partOfSpeech: '', role: '', reasoning: '', contrast: '', senseKey: '', constructionIds: ['c'] }],
    constructions: [{ id: 'c', statement: '虽然…但…', ranges: [{ start: 0, end: 2 }, { start: 5, end: 6 }], meaning: '譲歩', roleInSentence: '', elements: [] }] } };
  const details = projectMeaningUnitDetails(sentence, []);
  expect(details[0].words.map(w => w.id)).toEqual(['first']);
  expect(details.every(d => d.constructions[0].crossesUnits)).toBe(true);
  expect(validateMeaningUnits(text, { ...meaningUnits, version: 2 })).toBe(false);
  expect(projectMeaningUnitDetails({ ...sentence, text: 'changed' }, [])).toEqual([]);
});
test('image anchors stay normalized and reject invalid geometry', () => {
  expect(validCaptureRect({ left: 0, top: .1, width: 1, height: .1 })).toBe(true);
  expect(captureButtonPosition([{ left: .95, top: .5, width: .02, height: .1 }])).toEqual({ left: '82%', top: '50%' });
  expect(captureButtonPosition([{ left: -1, top: 0, width: 1, height: 1 }])).toBeUndefined();
  expect(validCaptureRect({ left: NaN, top: 0, width: 1, height: 1 })).toBe(false);
});
test('expired native operations cannot be automatically resent', () => {
  expect(() => pendingCaptureRequest({ createdAt: new Date(Date.now() - 86400001).toISOString(), request: '{}' })).toThrow('CAPTURE_EXPIRED');
});
