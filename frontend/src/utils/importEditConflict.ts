import type { ImportItem, ImportSession } from '../types';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Reapply only fields edited since the last acknowledged save. Never overwrite a concurrent edit. */
export function rebaseImportEdits(base: ImportSession, local: ImportSession, remote: ImportSession): ImportSession {
  if (base.id !== remote.id || local.text !== remote.text || remote.activeRevisionId || remote.analysisState === 'queued' || remote.analysisState === 'running') throw new Error('The source changed or analysis is running. Keep the saved version and copy your pending edits manually.');
  const next = structuredClone(remote);
  for (const field of ['title', 'wordGroupId', 'grammarGroupId', 'groupBNames', 'focusedSentenceIndex', 'status'] as const) {
    if (equal(local[field], base[field])) continue;
    if (!equal(remote[field], base[field]) && !equal(remote[field], local[field])) throw new Error(`Both windows changed ${field}. Compare the two versions before copying this edit.`);
    Object.assign(next, { [field]: local[field] });
  }
  const oldItems = new Map(base.items.map(i => [i.id, i]));
  for (const item of local.items) {
    const old = oldItems.get(item.id);
    if (equal(old, item)) continue;
    const target = next.items.find(i => i.id === item.id);
    if (!old) { if (!target) next.items.push(item); else if (!equal(target, item)) throw new Error('A new candidate conflicts with the saved version.'); continue; }
    if (!target || target.hiddenByRevision || target.status === 'skipped' && item.status !== 'skipped') throw new Error('A candidate was replaced in the saved version. Copy the pending edit to a new candidate.');
    const merged = { ...target };
    for (const field of new Set([...Object.keys(old), ...Object.keys(item)])) {
      const key = field as keyof ImportItem;
      if (equal(old[key], item[key])) continue;
      if (['queued', 'registered', 'duplicate'].includes(target.status) && ['term', 'statement', 'description', 'meaning', 'surface', 'range'].includes(field)) throw new Error('A changed candidate has been registered. Its pending text cannot replace the registration.');
      if (!equal(target[key], old[key]) && !equal(target[key], item[key])) throw new Error(`Both windows changed candidate ${item.id}: ${field}.`);
      Object.assign(merged, { [field]: item[key] });
    }
    next.items = next.items.map(i => i.id === item.id ? merged : i);
  }
  next.paragraphs = next.paragraphs.map(p => ({ ...p, sentences: p.sentences.map(s => {
    const old = base.paragraphs.flatMap(p => p.sentences).find(i => i.index === s.index);
    const edited = local.paragraphs.flatMap(p => p.sentences).find(i => i.index === s.index);
    if (!edited || equal(old, edited)) return s;
    if (!equal(s, old) && !equal(s, edited)) throw new Error('Both windows changed a sentence explanation.');
    return edited;
  }) }));
  return next;
}
