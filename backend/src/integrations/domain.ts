import { createHash } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction, type DocumentSnapshot, type DocumentReference } from '@google-cloud/firestore';
import type { FastifyBaseLogger } from 'fastify';
import { prepareWordRegistration } from '../services/word-registration.js';
import { prepareGrammarRegistration } from '../services/grammar-registration.js';
import { fillSegmentPinyin, stripMarkdownFences, callLLM } from '../llm.js';
import { wordIndexDocId } from '../word-index-id.js';
import { normalizeWordDefinitions, normalizeWordRecord } from '../word-format.js';
import type { IntegrationOperation } from './operations.js';
import type { ToolName } from './contracts.js';

export class DomainError extends Error { constructor(readonly code: string, readonly retryable = false) { super(code); } }
export const versionOf = (doc: DocumentSnapshot) => doc.updateTime ? `${doc.updateTime.seconds}:${doc.updateTime.nanoseconds}` : '';
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type RecordData = Record<string, any>;
export interface PreparedMutation { data?: RecordData; examples?: RecordData[]; expectedVersion?: string }

/** LLM work is checkpointed before entry into any Firestore transaction. */
export async function prepareMutation(op: IntegrationOperation, db: Firestore, log: FastifyBaseLogger): Promise<PreparedMutation> {
  const input = op.input as RecordData;
  if (op.action === 'create_word') {
    const prepared = await prepareWordRegistration('chinese', { ...input.word,
      groupIds: input.targets?.groupAIds, groupBIds: input.targets?.groupBIds }, log);
    if (prepared.merged.definitions.some(d => ['ko','ja','en'].some(code => !d.text?.[code]?.trim()))) throw new DomainError('ENRICHMENT_FAILED',true);
    return clean({ data: { ...prepared.merged, examples: undefined, ...(prepared.hanjaReadings ? { hanjaReadings: prepared.hanjaReadings } : {}) },
      examples: await prepareExamples(prepared.examplesWithSegments.slice(0, 10)) });
  }
  if (op.action === 'create_grammar') {
    const { examples, ...body } = input.grammar;
    return clean({ data: await prepareGrammarRegistration(body), examples: await prepareExamples(examples ?? []) });
  }
  if (op.action.startsWith('update_')) {
    const word = op.action === 'update_word';
    const doc = await db.collection(word ? 'words' : 'grammar_items').doc(input.itemId).get();
    if (!doc.exists || doc.data()!.language !== 'chinese') throw new DomainError('NOT_FOUND');
    if (versionOf(doc) !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT');
    const current = doc.data()!;
    const patch = { ...input.patch };
    const meaningsKey = word ? 'definitions' : 'descriptions';
    const updates = patch[word ? 'definitionTextUpdates' : 'descriptionTextUpdates'];
    const replace = patch[word ? 'replaceDefinitions' : 'replaceDescriptions'];
    delete patch.definitionTextUpdates; delete patch.descriptionTextUpdates; delete patch.replaceDefinitions; delete patch.replaceDescriptions;
    if (replace) patch[meaningsKey] = replace;
    else if (updates) {
      const meanings = clean(current[meaningsKey] ?? (word ? normalizeWordDefinitions(current) : []));
      for (const update of updates) {
        if (!meanings[update.index]) throw new DomainError('VALIDATION_ERROR');
        meanings[update.index].text[update.language] = update.text;
      }
      patch[meaningsKey] = meanings;
    }
    const changes = patch.exampleChanges; delete patch.exampleChanges;
    let examples: RecordData[] | undefined;
    if (changes) {
      const ownedIds: string[] = current.exampleIds ?? [];
      if ((changes.removeOwnedIds ?? []).some((id: string) => !ownedIds.includes(id))) throw new DomainError('INVALID_EXAMPLE_OWNERSHIP');
      const keep = ownedIds.filter(id => !(changes.removeOwnedIds ?? []).includes(id));
      const docs = keep.length ? await db.getAll(...keep.map(id => db.collection('example_sentences').doc(id))) : [];
      const owned = docs.filter(d => d.exists).map(d => ({ ...d.data()!, existingId: d.id }));
      examples = changes.replaceOwned !== undefined ? await prepareExamples(changes.replaceOwned)
        : [...owned, ...await prepareExamples(changes.add ?? [])];
      if (examples.length > 100) throw new DomainError('OPERATION_TOO_LARGE');
    }
    return clean({ data: patch, ...(examples !== undefined ? { examples } : {}), expectedVersion: input.expectedVersion });
  }
  return {};
}
async function prepareExamples(examples: RecordData[]): Promise<RecordData[]> {
  const result = clean(examples);
  const splits = result.map((ex, index) => ({ index, ex })).filter(({ ex }) => ex.userSplits?.length);
  if (splits.length) {
    const filled = await fillSegmentPinyin(splits.map(({ ex }) => ({ sentence: ex.sentence, splits: ex.userSplits })));
    splits.forEach(({ index }, i) => { result[index].segments = filled.get(i) ?? []; });
  }
  const missing = result.filter(ex => typeof ex.translation === 'string' ? !ex.translation.trim() : !Object.values(ex.translation ?? {}).some(Boolean));
  if (missing.length) {
    const raw = await callLLM({ system: 'Translate each Chinese sentence into Korean, Japanese and English. Preserve sentence order. Return JSON only.',
      user: JSON.stringify(missing.map(ex => ex.sentence)), schema: { type: 'object', additionalProperties: false, required: ['translations'], properties: {
        translations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ko','ja','en'], properties: { ko: { type: 'string' }, ja: { type: 'string' }, en: { type: 'string' } } } } } }, route: 'grammar/translate-examples' });
    const translations = JSON.parse(stripMarkdownFences(raw)).translations;
    if (translations?.length !== missing.length || translations.some((t: RecordData) => !t.ko?.trim() || !t.ja?.trim() || !t.en?.trim())) throw new DomainError('ENRICHMENT_FAILED', true);
    missing.forEach((ex, i) => { ex.translation = translations[i]; });
  }
  result.forEach(ex => { delete ex.userSplits; });
  return result;
}

/** Stages writes until every read is finished. Bounded to remain below Firestore's transaction limits. */
class Writes {
  private writes = new Map<string, { ref: DocumentReference; data: RecordData | null; merge: boolean }>();
  set(ref: DocumentReference, data: RecordData, merge = false) {
    const old = this.writes.get(ref.path);
    this.writes.set(ref.path, { ref, data: { ...(old?.data ?? {}), ...data }, merge: old ? old.merge && merge : merge });
  }
  delete(ref: DocumentReference) { this.writes.set(ref.path, { ref, data: null, merge: false }); }
  flush(tx: Transaction) {
    if (this.writes.size > 350) throw new DomainError('OPERATION_TOO_LARGE');
    for (const { ref, data, merge } of this.writes.values()) data === null ? tx.delete(ref) : tx.set(ref, data, { merge });
  }
}
function requireChinese(doc: DocumentSnapshot) {
  if (!doc.exists || doc.data()!.language !== 'chinese') throw new DomainError('NOT_FOUND');
}

export async function commitMutation(db: Firestore, tx: Transaction, op: IntegrationOperation, prepared: PreparedMutation): Promise<Record<string, unknown>> {
  const input = op.input as RecordData;
  const word = op.action.includes('word') || input.kind === 'word';
  const collection = db.collection(word ? 'words' : 'grammar_items');
  const groups = db.collection(word ? 'word_groups' : 'grammar_groups');
  const members = word ? 'wordIds' : 'grammarIds';
  const writes = new Writes();
  const allGroups = (await tx.get(groups.where('language', '==', 'chinese'))).docs;
  if (allGroups.length > 250) throw new DomainError('OPERATION_TOO_LARGE');
  if (op.action === 'create_group') {
    const existing = input.category === 'B' ? allGroups.find(g => g.data().category === 'B' && g.data().name.trim() === input.name) : undefined;
    const id = existing?.id ?? op.allocatedItemId;
    if (!existing) writes.set(groups.doc(id), { id, language: 'chinese', name: input.name, [members]: [], createdAt: new Date().toISOString(), ...(input.category === 'B' ? { category: 'B' } : {}) });
    writes.flush(tx); return { kind: 'group', itemId: id };
  }
  const create = op.action.startsWith('create_');
  const deleting = op.action.startsWith('delete_');
  const id = create ? op.allocatedItemId : input.itemId;
  const ref = collection.doc(id);
  const current = await tx.get(ref);
  if (create && current.exists) throw new DomainError('ID_CONFLICT');
  if (!create) { requireChinese(current); if (versionOf(current) !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT'); }
  const before = current.data() ?? {};
  const after = { ...before, ...prepared.data, language: 'chinese' } as RecordData;
  if (word && after.definitions) after.definitions = normalizeWordDefinitions(after);
  const targets = input.targets ?? {};
  const select = (ids: string[], category: 'A' | 'B') => ids.map(id => {
    const group = allGroups.find(g => g.id === id);
    if (!group || (group.data().category === 'B' ? 'B' : 'A') !== category) throw new DomainError('INVALID_GROUP');
    return group;
  });
  let selectedA: typeof allGroups = [], selectedB: typeof allGroups = [];
  if (create) {
    selectedA = select(targets.groupAIds ?? [], 'A'); selectedB = select(targets.groupBIds ?? [], 'B');
    if (!selectedA.length) selectedA = allGroups.filter(g => g.data().category !== 'B').sort((a,b) => b.data().createdAt.localeCompare(a.data().createdAt) || b.id.localeCompare(a.id)).slice(0,1);
    if (!selectedA.length) throw new DomainError('NO_GROUP_A');
  } else if (op.action === 'change_item_groups') {
    selectedA = input.groupAIds ? select(input.groupAIds, 'A') : allGroups.filter(g => g.data().category !== 'B' && (g.data()[members] ?? []).includes(id));
    selectedB = select(input.addBIds ?? [], 'B'); select(input.removeBIds ?? [], 'B');
  }
  if (create || op.action === 'change_item_groups' || deleting) {
    for (const g of allGroups) {
      const old: string[] = g.data()[members] ?? [];
      const isB = g.data().category === 'B';
      let next = old;
      if (deleting) next = old.filter(v => v !== id);
      else if (!isB && (create || input.groupAIds)) next = selectedA.some(s => s.id === g.id) ? [...new Set([...old,id])] : old.filter(v => v !== id);
      else if (isB && selectedB.some(s => s.id === g.id)) next = [...new Set([...old,id])];
      else if (isB && input.removeBIds?.includes(g.id)) next = old.filter(v => v !== id);
      if (JSON.stringify(old) !== JSON.stringify(next)) {
        writes.set(g.ref, { [members]: next }, true);
        if (!deleting && !old.includes(id)) after[isB ? 'addedToGroupBAt' : 'addedToGroupAAt'] = new Date().toISOString();
      }
    }
  }
  // Serialize term/statement competitors across new integrations; word index is also shared with legacy writers.
  if (word) {
    const term = after.term;
    const indexRef = db.collection('word_index').doc(wordIndexDocId('chinese', term));
    const index = await tx.get(indexRef);
    if (!deleting && index.exists && index.data()!.id !== id) {
      const other = await tx.get(collection.doc(index.data()!.id));
      if (other.exists && other.data()!.term === term && other.data()!.language === 'chinese') throw new DomainError('DUPLICATE_ITEM');
    }
    if (deleting || before.term && before.term !== term) {
      const oldIndex = db.collection('word_index').doc(wordIndexDocId('chinese', before.term));
      const old = await tx.get(oldIndex);
      if (old.data()?.id === id) writes.delete(oldIndex);
    }
    if (!deleting) writes.set(indexRef, { language: 'chinese', term, id, level: after.level ?? '', transliteration: after.transliteration ?? '' });
  } else if (!deleting && (create || after.statement !== before.statement)) {
    const guard = db.collection('integration_grammar_keys').doc(hashText(after.statement));
    await tx.get(guard);
    const matches = await tx.get(collection.where('language','==','chinese').where('statement','==',after.statement).limit(2));
    if (!input.allowDuplicateStatement && matches.docs.some(d => d.id !== id)) throw new DomainError('DUPLICATE_ITEM');
    writes.set(guard, { updatedAt: Date.now() });
  }
  // Resolve examples and maintain references in the same transaction as the item/receipt.
  const exampleCollection = db.collection('example_sentences');
  const exampleDocs = new Map<string, DocumentSnapshot>();
  const linkedAdditions = new Map<string, Set<string>>();
  const loadExample = async (exampleId: string) => {
    if (!exampleDocs.has(exampleId)) exampleDocs.set(exampleId, await tx.get(exampleCollection.doc(exampleId)));
    return exampleDocs.get(exampleId)!;
  };
  const oldIds: string[] = before.exampleIds ?? [];
  let newIds = [...oldIds];
  const desiredExamples = prepared.examples ?? (!Array.isArray(before.exampleIds) && Array.isArray(before.examples) ? before.examples : undefined);
  if (deleting) newIds = [];
  else if (desiredExamples !== undefined) {
    newIds = [];
    for (const ex of desiredExamples) {
      if (ex.existingId) { const doc = await loadExample(ex.existingId); requireChinese(doc); newIds.push(doc.id); continue; }
      const indexRef = db.collection('example_sentence_index').doc(`chinese_${hashText(ex.sentence).slice(0,16)}`);
      const index = await tx.get(indexRef);
      let exampleId = index.data()?.exampleId ?? `exs-zh-integration-${hashText(ex.sentence).slice(0,32)}`;
      let doc = await loadExample(exampleId);
      let variant = false;
      const supplied = ex.translation;
      const stored = doc.data()?.translation;
      const conflict = typeof supplied === 'object' && supplied !== null && (typeof stored === 'string' && stored.trim()
        || typeof stored === 'object' && stored !== null && Object.entries(supplied).some(([language,value]) => typeof value === 'string' && value.trim() && stored[language]?.trim() && stored[language] !== value));
      if (doc.exists && conflict) {
        variant = true;
        const normalized = Object.fromEntries(Object.entries(supplied).sort(([a],[b]) => a.localeCompare(b)));
        exampleId = `exs-zh-variant-${hashText(JSON.stringify([ex.sentence,normalized])).slice(0,32)}`;
        doc = await loadExample(exampleId);
      }
      if (doc.exists && (doc.data()!.sentence !== ex.sentence || doc.data()!.language !== 'chinese')) throw new DomainError('EXAMPLE_COLLISION');
      if (!doc.exists) {
        const { existingId: _drop, id: _id, ...example } = ex;
        // Resolve segment IDs from live Chinese words inside this transaction, never from model-supplied IDs.
        if (example.segments) {
          const segments: RecordData[] = [];
          for (const segment of example.segments) {
            const entry = await tx.get(db.collection('word_index').doc(wordIndexDocId('chinese', segment.text)));
            const linkedId = entry.data()?.id;
            const linked = linkedId ? await tx.get(db.collection('words').doc(linkedId)) : null;
            const valid = linked?.exists && linked.data()!.language === 'chinese' && linked.data()!.term === segment.text && !(deleting && linkedId === id);
            segments.push({ text: segment.text, ...(segment.transliteration ? { transliteration: segment.transliteration } : {}), ...(valid ? { id: linkedId } : {}) });
            if (valid && linkedId !== id) { if (!linkedAdditions.has(linkedId)) linkedAdditions.set(linkedId,new Set()); linkedAdditions.get(linkedId)!.add(exampleId); }
          }
          example.segments = segments;
        }
        writes.set(doc.ref, { ...example, language: 'chinese' });
        if (!variant) writes.set(indexRef, { exampleId });
      }
      if (doc.exists && ex.translation && typeof ex.translation === 'object') {
        const translation = { ...ex.translation };
        if (typeof doc.data()!.translation === 'object') for (const [language,value] of Object.entries(doc.data()!.translation)) if (typeof value === 'string' && value.trim()) translation[language] = value;
        writes.set(doc.ref, { translation }, true);
      }
      newIds.push(exampleId);
    }
  }
  newIds = [...new Set(newIds)];
  if (oldIds.length > 150 || (before.appearsInIds?.length ?? 0) > 200) throw new DomainError('OPERATION_TOO_LARGE');
  for (const exampleId of new Set([...oldIds, ...newIds, ...(word && deleting ? before.appearsInIds ?? [] : [])])) {
    const doc = await loadExample(exampleId); const data = doc.data();
    if (!data && !newIds.includes(exampleId)) continue;
    if (!word) {
      const reverse: string[] = data?.appearsInGrammarIds ?? [];
      const next = newIds.includes(exampleId) ? [...new Set([...reverse,id])] : reverse.filter(v => v !== id);
      writes.set(doc.ref, { appearsInGrammarIds: next }, true);
    }
    if (word && deleting && data?.segments?.some((s: RecordData) => s.id === id)) {
      writes.set(doc.ref, { segments: data.segments.map((s: RecordData) => { if (s.id !== id) return s; const { id: _drop, ...rest } = s; return rest; }) }, true);
    }
  }
  if (deleting) { writes.delete(ref); if (word) writes.delete(db.collection('progress').doc(`chinese_${id}`)); }
  else {
    delete after.examples;
    after.exampleIds = newIds;
    if (word) {
      const keep = new Set<string>(before.appearsInIds ?? []);
      for (const old of oldIds) if (!newIds.includes(old)) {
        const doc = await loadExample(old);
        if (!doc.data()?.segments?.some((s: RecordData) => s.id === id)) keep.delete(old);
      }
      newIds.forEach(ex => keep.add(ex)); after.appearsInIds = [...keep];
    }
    writes.set(ref, clean(word ? normalizeWordRecord(after) : after));
  }
  for (const [linkedId, examples] of linkedAdditions) writes.set(db.collection('words').doc(linkedId),{ appearsInIds: FieldValue.arrayUnion(...examples) },true);
  writes.flush(tx);
  return { kind: word ? 'word' : 'grammar', itemId: id, deleted: deleting,
    warnings: deleting || oldIds.some(ex => !newIds.includes(ex)) ? ['Unreferenced shared example documents are retained for safe garbage collection.'] : [] };
}
