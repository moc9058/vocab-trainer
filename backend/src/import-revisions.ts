import { convertedConstruction, syncConvertedWordReading } from './import-word-links.js';
import { sourceHash, jobActive } from './import-jobs.js';
import { ImportCheckpointError } from './import-parts.js';
import { rebaseReadingAnalysis } from './import-reading-analysis.js';
import type { ImportAnalysisResult, ImportConversionInput, ImportGrammarItem, ImportItem, ImportRevision, ImportRevisionRequest, ImportSession } from './types.js';

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
/** Firestore encodes strings as UTF-8, so payload parts must not split a surrogate pair. */
export function splitRevisionPayload(value: unknown): string[] {
  const json = JSON.stringify(value), parts: string[] = [];
  for (let at = 0; at < json.length;) {
    let end = Math.min(json.length, at + 100_000);
    if (end < json.length && /[\uD800-\uDBFF]/u.test(json[end - 1])) end--;
    parts.push(json.slice(at, end)); at = end;
  }
  return parts;
}
export const revisionSize = (value: unknown, limit = 900_000) => {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new ImportCheckpointError(413, 'Article is too large. Select fewer sentences.');
};
export function assertEditable(session: ImportSession, expected: number, allowRevision?: string) {
  if ((session.contentRevision ?? 0) !== expected) throw new ImportCheckpointError(409, 'The article changed. Reload and compare your edits before retrying.');
  if (jobActive(session.analysisState) || (session.activeRevisionId && session.activeRevisionId !== allowRevision)) throw new ImportCheckpointError(409, 'Another analysis or revision is running.');
  if (session.items.some(i => i.status === 'queued')) throw new ImportCheckpointError(409, 'Wait for pending registrations.');
}
export function newRevision(session: ImportSession, id: string, request: ImportRevisionRequest): ImportRevision {
  assertEditable(session, request.expectedRevision);
  const all = session.paragraphs.flatMap(p => p.sentences);
  const wanted = new Set(request.sentenceIndices);
  const indices = all.flatMap((s, i) => wanted.has(s.index) ? [i] : []);
  if (!indices.length || indices.length !== wanted.size || indices.length !== request.sentenceIndices.length || indices.some((n, i) => n !== indices[0] + i)) throw new ImportCheckpointError(400, 'Select consecutive sentences.');
  const targets = indices.map(i => ({ sentenceIndex: all[i].index, sourceText: all[i].text, sourceTextHash: sourceHash(all[i].text) }));
  // Whole containing paragraphs plus one sentence on either side. Trim context, never target.
  const paragraphs = session.paragraphs.filter(p => p.sentences.some(s => wanted.has(s.index)));
  const surrounding = new Set(paragraphs.flatMap(p => p.sentences.map(s => s.index)));
  for (const i of [indices[0] - 1, indices.at(-1)! + 1]) if (all[i]) surrounding.add(all[i].index);
  let budget = 4000;
  const context = all.filter(s => surrounding.has(s.index) && !wanted.has(s.index))
    .sort((a, b) => Math.min(...targets.map(t => Math.abs(t.sentenceIndex - a.index))) - Math.min(...targets.map(t => Math.abs(t.sentenceIndex - b.index))))
    .filter(s => { if (s.text.length > budget) return false; budget -= s.text.length; return true; })
    .sort((a, b) => a.index - b.index).map(s => ({ sentenceIndex: s.index, text: s.text }));
  const now = new Date().toISOString();
  return { id, sessionId: session.id, kind: request.kind, state: 'queued', request, targets, context, changes: [], sentences: [], createdAt: now, updatedAt: now };
}
const visible = (i: ImportItem) => i.status !== 'skipped' && !i.hiddenByRevision;
export function proposeRevision(session: ImportSession, revision: ImportRevision, analysis: ImportAnalysisResult): ImportRevision {
  const sentences = analysis.paragraphs.flatMap(p => p.sentences);
  if (sentences.length !== revision.targets.length || sentences.some((s, i) => s.text !== revision.targets[i].sourceText || !s.readingAnalysis)) throw new Error('IMPORT_SOURCE_MISMATCH: Reading analysis must match every selected sentence.');
  const changes: ImportRevision['changes'] = [];
  const result = sentences.map((s, i) => {
    const index = revision.targets[i].sentenceIndex;
    return { ...s, index, readingAnalysis: rebaseReadingAnalysis(s.readingAnalysis!, index - s.index) };
  });
  if (revision.request.update !== 'explanation') for (const [position, sentence] of sentences.entries()) {
    const index = revision.targets[position].sentenceIndex;
    const previous = session.items.filter((i): i is ImportGrammarItem => i.kind === 'grammar' && i.sentenceIndex === index && visible(i));
    const used = new Set<string>();
    for (const [n, point] of analysis.grammar.filter(g => g.sentenceIndex === sentence.index).entries()) {
      // Only exact, unambiguous patterns are associated automatically. The user reviews every change.
      const matches = previous.filter(p => p.statement === point.statement && !used.has(p.id));
      const before = matches.length === 1 ? matches[0] : undefined;
      if (before) used.add(before.id);
      const id = `${revision.id}-g${position}-${n}`;
      const after: ImportGrammarItem = { ...point, id, kind: 'grammar', status: 'pending', origin: 'llm', edited: true,
        revisionId: revision.id, sentenceIndex: index, order: before?.order ?? n,
        ...(point.constructionId ? { constructionId: point.constructionId.replace(/^s\d+-/, `s${index}-`) } : {}) };
      changes.push({ id, sentenceIndex: index, action: before ? 'replace' : 'add', ...(before ? { previousId: before.id, before } : {}), after });
    }
    for (const before of previous.filter(p => !used.has(p.id))) changes.push({ id: `${revision.id}-remove-${before.id}`, sentenceIndex: index, action: 'remove', previousId: before.id, before });
  }
  return { ...revision, state: 'proposed', changes, sentences: result, updatedAt: new Date().toISOString() };
}
export function applyRevision(session: ImportSession, revision: ImportRevision, selected: string[], sentenceIndices: number[]): ImportSession {
  assertEditable(session, revision.request.expectedRevision);
  if (revision.state !== 'proposed') throw new ImportCheckpointError(409, 'This proposal is not available.');
  for (const target of revision.targets) {
    const s = session.paragraphs.flatMap(p => p.sentences).find(s => s.index === target.sentenceIndex);
    if (!s || sourceHash(s.text) !== target.sourceTextHash || s.text !== target.sourceText) throw new ImportCheckpointError(409, 'The source changed.');
  }
  if (new Set(selected).size !== selected.length || selected.some(id => !revision.changes.some(c => c.id === id))) throw new ImportCheckpointError(400, 'Invalid candidate selection.');
  if (sentenceIndices.some(index => !revision.sentences.some(s => s.index === index)) || (revision.request.update === 'grammar' && sentenceIndices.length)) throw new ImportCheckpointError(400, 'Invalid explanation selection.');
  if (!selected.length && !sentenceIndices.length) throw new ImportCheckpointError(400, 'Select a change to apply.');
  let items = [...session.items];
  for (const change of revision.changes.filter(c => selected.includes(c.id))) {
    const old = items.find(i => i.id === change.previousId);
    if (old && canonical(old) !== canonical(change.before)) throw new ImportCheckpointError(409, 'A candidate changed.');
    if (old) items = items.map(i => i.id === old.id ? { ...i, hiddenByRevision: revision.id } : i);
    if (change.after) {
      // A semantically identical pattern can keep its entity identity and receipts, never a changed pattern.
      const after = old?.kind === 'grammar' && old.statement === change.after.statement
        ? { ...change.after, existingGrammarId: old.existingGrammarId, registrations: old.registrations, status: old.status, target: old.target, error: old.error } : change.after;
      items.push(after);
    }
  }
  const paragraphs = session.paragraphs.map(p => ({ ...p, sentences: p.sentences.map(s => {
    const next = revision.sentences.find(n => n.index === s.index && sentenceIndices.includes(s.index));
    if (!next) return s;
    const { readingAnalysis: _oldReading, ...rest } = s;
    return { ...rest, ...(next.readingAnalysis ? { readingAnalysis: { ...next.readingAnalysis, candidatesManaged: true } } : {}) };
  }) }));
  const next = { ...session, items, paragraphs, contentRevision: (session.contentRevision ?? 0) + 1, latestRevisionId: revision.id, updatedAt: new Date().toISOString() };
  revisionSize(next); return next;
}
export function convertCandidate(session: ImportSession, id: string, input: ImportConversionInput, expected: number): ImportSession {
  assertEditable(session, expected);
  const source = session.items.find(i => i.id === input.itemId && (i.kind === 'grammar' || !!i.convertedFromGrammarId) && visible(i));
  if (!source) throw new ImportCheckpointError(404, 'Grammar or converted word candidate not found.');
  if (source.kind === 'word' && (source.range?.start !== input.start || source.range.end !== input.end || source.term !== input.term.trim())) throw new ImportCheckpointError(400, 'Keep the converted word and its original range.');
  const sentence = session.paragraphs.flatMap(p => p.sentences).find(s => s.index === source.sentenceIndex)!;
  const { start, end } = input;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > sentence.text.length || /[\uD800-\uDBFF]$/.test(sentence.text.slice(0, start)) || /[\uD800-\uDBFF]$/.test(sentence.text.slice(0, end)) || !/\p{L}/u.test(sentence.text.slice(start, end)) || !input.term.trim()) throw new ImportCheckpointError(400, 'Select a complete word in the original sentence.');
  const surface = sentence.text.slice(start, end);
  const duplicate = session.items.find(i => i.id !== source.id && i.kind === 'word' && visible(i) && !i.suppressedByGrammar && i.sentenceIndex === source.sentenceIndex && i.range?.start === start && i.range.end === end);
  if (duplicate) throw new ImportCheckpointError(409, `A word candidate already exists at this position (${duplicate.id}). Edit that candidate instead.`);
  const word: ImportItem = source.kind === 'word'
    ? { ...source, meaning: input.meaning.trim(), transliteration: input.transliteration.trim(), explanationLanguage: input.explanationLanguage, edited: true }
    : { id: `${id}-word`, kind: 'word', sentenceIndex: source.sentenceIndex, order: start, origin: 'manual', edited: true, status: 'pending',
      term: input.term.trim(), sourceTerm: input.term.trim(), surface, range: { start, end }, meaning: input.meaning.trim(), transliteration: input.transliteration.trim(), explanationLanguage: input.explanationLanguage,
      sourceIds: [source.id], convertedFromGrammarId: source.id, revisionId: id };
  let items = session.items.map(i => i.id === word.id ? word : (i.id === source.id && input.mode === 'replace') || (i.kind === 'word' && i.suppressedByGrammar && i.sentenceIndex === source.sentenceIndex && i.range?.start === start && i.range.end === end) ? { ...i, hiddenByRevision: id } : i);
  if (source.kind === 'grammar') items.push(word);
  const paragraphs = session.paragraphs.map(p => ({ ...p, sentences: p.sentences.map(s => s.index === source.sentenceIndex ? syncConvertedWordReading(s, items) : s) }));
  // Changed article patterns get fresh candidates; library identities and receipts stay on the historical rows.
  const replacements: ImportGrammarItem[] = [];
  items = items.map(item => {
    if (item.kind !== 'grammar' || !visible(item) || item.sentenceIndex !== sentence.index) return item;
    const reading = sentence.readingAnalysis?.sourceText === sentence.text ? sentence.readingAnalysis : undefined;
    const original = reading?.constructions.find(c => c.id === item.constructionId || c.statement === item.statement);
    const fixed = (item.fixedElements ?? []).filter(e => sentence.text.slice(e.range.start, e.range.end) === e.surface);
    const occurrences = original ? reading!.occurrences : fixed.map((e, n) => ({ id: `fixed-${n}`, range: e.range, surface: e.surface, lemma: e.surface, contextualMeaning: e.meaning, explanationLanguage: 'ja', partOfSpeech: '', role: '', reasoning: '', contrast: '', senseKey: '', constructionIds: [] }));
    const point = convertedConstruction(sentence, items, original ?? { id: item.id, statement: item.statement, meaning: item.description, roleInSentence: '', elements: [], ranges: fixed.map(e => e.range) }, occurrences);
    if (point.statement === item.statement) return item;
    const { existingGrammarId: _entity, registrations: _receipts, target: _target, error: _error, ...rest } = item;
    replacements.push({ ...rest, id: `${id}-linked-${item.id}`, statement: point.statement, fixedElements: fixed.filter(e => !items.some(w => w.kind === 'word' && w.convertedFromGrammarId && visible(w) && w.sentenceIndex === sentence.index && w.range?.start === e.range.start && w.range.end === e.range.end)), status: 'pending', revisionId: id });
    return { ...item, hiddenByRevision: id };
  });
  const next = { ...session, items: [...items, ...replacements], paragraphs,
    contentRevision: expected + 1, latestRevisionId: id, updatedAt: new Date().toISOString() };
  revisionSize(next); return next;
}
export function undoRevision(session: ImportSession, revision: ImportRevision): ImportSession {
  assertEditable(session, revision.appliedRevision ?? -1);
  if (revision.state !== 'applied' || session.latestRevisionId !== revision.id || !revision.before || !revision.after) throw new ImportCheckpointError(409, 'Later changes prevent undo. Compare a restoration proposal instead.');
  // Strict revision guard deliberately refuses registrations or edits made after application.
  const ids = new Set(revision.after.items.map(i => i.id));
  const indices = new Set(revision.before.sentences.map(s => s.index));
  const next = { ...session, items: [...session.items.filter(i => !ids.has(i.id)), ...revision.before.items],
    paragraphs: session.paragraphs.map(p => ({ ...p, sentences: p.sentences.map(s => indices.has(s.index) ? revision.before!.sentences.find(old => old.index === s.index)! : s) })),
    contentRevision: (session.contentRevision ?? 0) + 1, updatedAt: new Date().toISOString() };
  delete next.latestRevisionId;
  revisionSize(next); return next;
}
