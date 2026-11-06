import type { Firestore } from '@google-cloud/firestore';
import { createHmac } from 'node:crypto';
import { getWords, getGrammarItems } from '../firestore.js';
import { IntegrationOperationStore, type IntegrationOperation } from './operations.js';
import { requiredScopes, type IntegrationDispatcher, type IntegrationPrincipal } from './mcp.js';
import { parseToolInput, type ToolName } from './contracts.js';
import { DomainError, versionOf } from './domain.js';
import type { LibraryOAuth } from './oauth.js';
type Data = Record<string, any>;
export function operationScopes(action: ToolName, input: Data): string[] {
  const scopes = requiredScopes(action);
  if (action === 'create_group' || action === 'change_item_groups') scopes.push(`${input.kind === 'word' ? 'vocab' : 'grammar'}.read`, `${input.kind === 'word' ? 'vocab' : 'grammar'}.write`);
  return scopes;
}
export function operationResult(op: IntegrationOperation) {
  return { operationId: op.operationId, kind: op.action, status: op.status, stage: op.stage, result: op.result ?? null,
    error: op.error ?? null, expiresAt: op.expiresAt, ...(op.status === 'queued' || op.status === 'running' ? { pollAfterMs: 3000 } : {}) };
}
export class LibraryIntegrationService implements IntegrationDispatcher {
  readonly operations: IntegrationOperationStore;
  constructor(readonly db: Firestore, readonly oauth: LibraryOAuth, readonly cursorSecret: string,
    private readonly dispatch: () => Promise<unknown>) { this.operations = new IntegrationOperationStore(db); }
  async authorize(principal: IntegrationPrincipal, scopes: readonly string[]) {
    const live = await this.oauth.principal(principal.connectionId);
    return !!live && live.id === principal.id && scopes.every(s => principal.scopes.includes(s) && live.scopes.includes(s));
  }
  private async dispatchAccepted() {
    // Acceptance already committed an outbox entry. Dispatch failure must not
    // turn a durable accepted operation into an ambiguous tool-call error.
    try { await this.dispatch(); } catch { /* The scheduled reconciler retries the outbox. */ }
  }
  private cursor(value: string | undefined, context: unknown): number {
    if (!value) return 0;
    const [offset, signature] = value.split('.');
    if (!/^[0-9]{1,6}$/.test(offset) || signature !== this.sign(Number(offset),context)) throw new DomainError('INVALID_CURSOR');
    return Number(offset);
  }
  private sign(offset: number, context: unknown) { return createHmac('sha256',this.cursorSecret).update(JSON.stringify([offset,context])).digest('base64url'); }
  private page<T>(items: T[], offset: number, limit: number, context: unknown, more = offset+limit<items.length) {
    return { items: items.slice(offset,offset+limit), hasMore: more, nextCursor: more ? `${offset+limit}.${this.sign(offset+limit,context)}` : null };
  }
  async execute(name: ToolName, raw: unknown, principal: IntegrationPrincipal): Promise<Record<string,unknown>> {
    const input = parseToolInput(name,raw) as Data;
    if (!await this.authorize(principal,operationScopes(name,input))) throw new DomainError('FORBIDDEN');
    let result: Record<string,unknown>;
    if (name === 'get_connection_profile') result = { library: 'Vocab Trainer shared library', language: 'chinese', connectionId: principal.connectionId };
    else if (name === 'get_operation' || name === 'retry_operation') {
      const op = await this.operations.get(principal,input.operationId);
      if (!op) throw new DomainError('NOT_FOUND');
      if (!await this.authorize(principal,operationScopes(op.action,op.input as Data))) throw new DomainError('FORBIDDEN');
      if (name === 'retry_operation') { await this.operations.retry(principal,input.operationId); await this.dispatchAccepted(); }
      result = operationResult((await this.operations.get(principal,input.operationId))!);
    } else if (name === 'list_operations') {
      const context = [principal.id,name,input.status ?? null]; const offset = this.cursor(input.cursor,context);
      const docs = await this.db.collection('integration_operations').where('principalId','==',principal.id).get();
      const ops = docs.docs.map(d => d.data() as IntegrationOperation).filter(op => op.expiresAt > Date.now() && (!input.status || op.status === input.status))
        .sort((a,b) => b.createdAt-a.createdAt || a.operationId.localeCompare(b.operationId));
      const visible: ReturnType<typeof operationResult>[] = [];
      for (const op of ops) if (await this.authorize(principal,operationScopes(op.action,op.input as Data))) visible.push(operationResult(op));
      result = this.page(visible,offset,input.limit,context);
    } else if (name === 'get_word' || name === 'get_grammar') {
      const word = name === 'get_word'; const collection = this.db.collection(word ? 'words' : 'grammar_items');
      const doc = await collection.doc(input.itemId).get();
      if (!doc.exists || doc.data()!.language !== 'chinese') throw new DomainError('NOT_FOUND');
      const { exampleIds = [], appearsInIds = [], examples: legacyExamples = [], ...data } = doc.data()!;
      const groups = await this.db.collection(word ? 'word_groups' : 'grammar_groups').where('language','==','chinese').get();
      const context = [name,input.itemId,versionOf(doc)]; const offset = this.cursor(input.cursor,context);
      const ids = [...new Set([...exampleIds,...appearsInIds])] as string[];
      const selected = ids.slice(offset,offset+10);
      const examples = selected.length ? await this.db.getAll(...selected.map(id => this.db.collection('example_sentences').doc(id))) : [];
      const entries = examples.filter(d => d.exists && d.data()!.language === 'chinese').map(d => ({ id: d.id, ...d.data()!, ownership: exampleIds.includes(d.id) ? 'owned' : 'referenced' }));
      const more = offset+10 < ids.length;
      result = { id: doc.id, kind: word ? 'word' : 'grammar', language: 'chinese', version: versionOf(doc), data,
        groups: groups.docs.filter(d => (d.data()[word ? 'wordIds' : 'grammarIds'] ?? []).includes(doc.id)).map(d => ({ id: d.id, name: d.data().name, category: d.data().category ?? 'A' })),
        examples: entries.length ? entries : ids.length ? [] : legacyExamples.slice(offset,offset+10), hasMore: more,
        nextCursor: more ? `${offset+10}.${this.sign(offset+10,context)}` : null };
    } else if (name === 'list_groups') {
      const context = [name,input.kind,input.category ?? null]; const offset = this.cursor(input.cursor,context);
      const docs = await this.db.collection(input.kind === 'word' ? 'word_groups' : 'grammar_groups').where('language','==','chinese').get();
      const items = docs.docs.map(d => ({ id: d.id, name: d.data().name, category: d.data().category ?? 'A', createdAt: d.data().createdAt }))
        .filter(g => !input.category || g.category === input.category).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      result = this.page(items,offset,input.limit,context);
    } else if (name === 'search_words' || name === 'search_grammar') {
      const word = name === 'search_words'; const { cursor: _cursor, ...filters } = input;
      const context = [name,filters]; const offset = this.cursor(input.cursor,context);
      let items: Data[]; let more: boolean;
      let memberIds: string[] | undefined;
      if (input.groupId) {
        const group = await this.db.collection(word ? 'word_groups' : 'grammar_groups').doc(input.groupId).get();
        if (!group.exists || group.data()!.language !== 'chinese') throw new DomainError('INVALID_GROUP');
        memberIds = group.data()![word ? 'wordIds' : 'grammarIds'] ?? [];
      }
      if (input.match === 'exact' && input.query) {
        const docs = await this.db.collection(word ? 'words' : 'grammar_items').where('language','==','chinese').where(word ? 'term' : 'statement','==',input.query).get();
        items = docs.docs.filter(d => !memberIds || memberIds.includes(d.id)).map(d => ({ id: d.id,...d.data() }));
        items = items.slice(offset,offset+input.limit+1); more = items.length > input.limit; items = items.slice(0,input.limit);
      } else {
        const getter = word ? getWords : getGrammarItems;
        const response = await getter('chinese',{ search: input.query, searchIn: input.searchIn, groupId: input.groupId },{ page: Math.floor(offset/input.limit)+1, limit: input.limit });
        items = response.items; more = offset+items.length < response.total;
      }
      const verified = items.length ? await this.db.getAll(...items.map(item => this.db.collection(word ? 'words' : 'grammar_items').doc(item.id))) : [];
      items = verified.filter(d => d.exists && d.data()!.language === 'chinese').map(d => ({ id: d.id, ...d.data() }));
      result = { items: items.map(item => ({ id: item.id, term: item.term, statement: item.statement,
        meanings: (word ? item.definitions : item.descriptions)?.map((d: Data) => d.text), transliteration: item.transliteration })), hasMore: more,
        nextCursor: more ? `${offset+input.limit}.${this.sign(offset+input.limit,context)}` : null };
    } else {
      const op = await this.operations.accept(principal,name,input);
      await this.dispatchAccepted(); result = operationResult(op);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 90000) throw new DomainError('RESPONSE_TOO_LARGE');
    return result;
  }
}
