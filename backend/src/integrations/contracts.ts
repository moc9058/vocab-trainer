/** Shared integration.v1 boundary. Never expose Partial<Word> to an external agent. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TOPICS } from '../types.js';

const text = (max = 8000) => z.string().max(max).refine(value => value.trim().length > 0, 'Must not be blank');
export const itemId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const operationId = z.string().uuid();
const iso = z.enum(['en', 'ja', 'ko', 'zh']);
const translations = z.partialRecord(iso, text()).refine(value => Object.keys(value).length > 0, 'A translation is required');
const definition = z.strictObject({
  text: z.partialRecord(z.enum(['en', 'ja', 'ko']), text()).refine(value => Object.keys(value).length > 0),
  pinyins: z.array(text(200)).min(1).max(20).optional(),
});
const description = z.strictObject({
  partOfSpeech: z.literal(''),
  text: translations.refine(value => Boolean(value.ko || value.ja), 'A Korean or Japanese anchor is required'),
  pinyins: z.array(text(200)).min(1).max(20).optional(),
});
const example = z.strictObject({
  sentence: text(),
  translation: z.union([z.string().max(8000), translations]),
  userSplits: z.array(text(200)).min(1).max(1000).optional(),
});
const ids = z.array(itemId).max(100).refine(value => new Set(value).size === value.length, 'Duplicate IDs are not allowed');
const targets = (word: boolean) => z.strictObject({
  groupAIds: word ? ids.max(1).optional() : ids.optional(), groupBIds: ids.optional(),
}).refine(value => (value.groupAIds?.length ?? 0) + (value.groupBIds?.length ?? 0) <= 100, 'Too many groups')
  .refine(value => !(value.groupAIds ?? []).some(id => value.groupBIds?.includes(id)), 'A and B targets must be disjoint');
const sourceContext = z.strictObject({ sentence: text(), surface: text(), contextualMeaning: text(2000), explanationLanguage: iso });
const wordData = z.strictObject({
  term: text(200).transform(value => value.trim()), transliteration: text(1000).optional(),
  definitions: z.array(definition).min(1).max(20).optional(), examples: z.array(example).max(10).optional(),
  topics: z.array(z.enum(TOPICS)).max(TOPICS.length).optional(),
  level: z.enum(['HSK1-4', 'HSK5', 'HSK6', 'HSK7-9', 'Advanced']).optional(),
  notes: z.string().max(8000).optional(), sourceContext: sourceContext.optional(),
});
const grammarData = z.strictObject({
  statement: text(500).transform(value => value.trim()), transliteration: text(1000).optional(),
  descriptions: z.array(description).min(1).max(20), examples: z.array(example).max(10).optional(),
  level: text(100).optional(), tags: z.array(text(200)).max(100).optional(),
});
const languageUpdate = z.strictObject({ index: z.number().int().min(0).max(19), language: iso, text: text() });
const exampleChanges = z.strictObject({
  add: z.array(example).max(10).optional(), removeOwnedIds: ids.optional(), replaceOwned: z.array(example).max(10).optional(),
}).refine(value => !(value.replaceOwned !== undefined && (value.add !== undefined || value.removeOwnedIds !== undefined)), 'Replace cannot be combined with add/remove')
  .refine(value => Object.keys(value).length > 0, 'Empty example changes');
const wordPatch = wordData.omit({ definitions: true, examples: true, sourceContext: true }).partial().extend({
  definitionTextUpdates: z.array(languageUpdate.extend({ language: z.enum(['en', 'ja', 'ko']) })).min(1).max(60).optional(),
  replaceDefinitions: z.array(definition).min(1).max(20).optional(), exampleChanges: exampleChanges.optional(),
}).refine(value => Object.keys(value).length > 0, 'Empty patch')
  .refine(value => !(value.definitionTextUpdates && value.replaceDefinitions), 'Choose partial updates or replacement');
const grammarPatch = grammarData.omit({ descriptions: true, examples: true }).partial().extend({
  descriptionTextUpdates: z.array(languageUpdate).min(1).max(80).optional(),
  replaceDescriptions: z.array(description).min(1).max(20).optional(), exampleChanges: exampleChanges.optional(),
}).refine(value => Object.keys(value).length > 0, 'Empty patch')
  .refine(value => !(value.descriptionTextUpdates && value.replaceDescriptions), 'Choose partial updates or replacement');
const mutation = { operationId, itemId, expectedVersion: text(500) };
const page = { limit: z.number().int().min(1).max(50).default(20), cursor: text(2000).optional() };
const search = z.strictObject({ query: text(500).optional(), match: z.enum(['exact', 'contains']).default('contains'),
  searchIn: z.enum(['term', 'meaning', 'both']).default('term'), groupId: itemId.optional(), ...page });
const get = z.strictObject({ itemId, cursor: text(2000).optional() });
const kind = z.enum(['word', 'grammar']);
export const toolSchemas = {
  get_connection_profile: z.strictObject({}), search_words: search, get_word: get,
  create_word: z.strictObject({ operationId, word: wordData, targets: targets(true).optional() }),
  update_word: z.strictObject({ ...mutation, patch: wordPatch }), delete_word: z.strictObject(mutation),
  search_grammar: search, get_grammar: get,
  create_grammar: z.strictObject({ operationId, grammar: grammarData, targets: targets(false).optional(),
    allowDuplicateStatement: z.boolean().default(false), duplicateReason: text(2000).optional(),
  }).refine(value => !value.allowDuplicateStatement || Boolean(value.duplicateReason), 'Explain intentional duplication'),
  update_grammar: z.strictObject({ ...mutation, patch: grammarPatch }), delete_grammar: z.strictObject(mutation),
  list_groups: z.strictObject({ kind, category: z.enum(['A', 'B']).optional(), ...page }),
  create_group: z.strictObject({ operationId, kind, category: z.enum(['A', 'B']), name: text(200).transform(value => value.trim()) }),
  change_item_groups: z.strictObject({ ...mutation, kind, addBIds: ids.optional(), removeBIds: ids.optional(),
    groupAIds: ids.optional(),
  }).refine(value => value.kind !== 'word' || (value.groupAIds?.length ?? 0) <= 1, 'A word has one A home')
    .refine(value => value.groupAIds === undefined || value.groupAIds.length > 0, 'Cannot remove the last A home')
    .refine(value => Boolean(value.groupAIds?.length || value.addBIds?.length || value.removeBIds?.length), 'Empty membership change')
    .refine(value => !(value.addBIds ?? []).some(id => value.removeBIds?.includes(id)), 'Cannot add and remove the same membership'),
  get_operation: z.strictObject({ operationId }),
  list_operations: z.strictObject({ status: z.enum(['queued', 'running', 'succeeded', 'failed']).optional(), ...page }),
  retry_operation: z.strictObject({ operationId }),
} as const;
export type ToolName = keyof typeof toolSchemas;
export type ToolInput<T extends ToolName> = z.output<(typeof toolSchemas)[T]>;
export class IntegrationValidationError extends Error { readonly code = 'VALIDATION_ERROR'; }
export function parseToolInput<T extends ToolName>(name: T, input: unknown): ToolInput<T> {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(input); } catch { throw new IntegrationValidationError('Input must be JSON'); }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > 65536) throw new IntegrationValidationError('Input exceeds 64 KiB');
  const result = toolSchemas[name].safeParse(input);
  if (!result.success) throw new IntegrationValidationError(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return result.data as ToolInput<T>;
}
/** Hash only validated JSON. Defaults/transforms must run before this function. */
export function requestHash(name: ToolName, input: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
  return createHash('sha256').update(JSON.stringify({ version: 1, action: name, input: canonical(parseToolInput(name, input)) })).digest('hex');
}
export function inputJsonSchema(name: ToolName) { return z.toJSONSchema(toolSchemas[name], { io: 'input' }); }
