import { createHash, randomUUID } from 'node:crypto';
import type { Firestore, Transaction } from '@google-cloud/firestore';
import { parseToolInput, requestHash, type ToolName } from './contracts.js';
import type { IntegrationPrincipal } from './mcp.js';

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface IntegrationOperation {
  schemaVersion: 1; principalId: string; connectionId: string; operationId: string;
  action: ToolName; requestHash: string; input: unknown; allocatedItemId: string;
  status: OperationStatus; stage: 'validating' | 'enriching' | 'committing' | 'reconciling';
  attempt: number; generation: number; leaseUntil: number; coreCommitted: boolean;
  createdAt: number; updatedAt: number; expiresAt: number;
  result?: Record<string, unknown>; error?: { code: string; retryable: boolean };
}
export class OperationConflict extends Error {
  constructor(readonly code: string) { super(code); }
}
const identity = (principalId: string, operationId: string) => createHash('sha256').update(JSON.stringify([principalId, operationId])).digest('hex');
/** All execution is external/durable. No background promises are launched by acceptance. */
export class IntegrationOperationStore {
  constructor(private readonly db: Firestore, private readonly now = Date.now) {}
  private ref(principal: IntegrationPrincipal, operationId: string) {
    return this.db.collection('integration_operations').doc(identity(principal.id, operationId));
  }
  async accept(principal: IntegrationPrincipal, action: ToolName, raw: unknown): Promise<IntegrationOperation> {
    const input = parseToolInput(action, raw) as { operationId?: string };
    if (!input.operationId || !/^(create_|update_|delete_|change_)/.test(action)) throw new OperationConflict('INVALID_MUTATION');
    const operationId = input.operationId;
    const hash = requestHash(action, input);
    const ref = this.ref(principal, operationId);
    const timestamp = this.now();
    const candidate: IntegrationOperation = {
      schemaVersion: 1, principalId: principal.id, connectionId: principal.connectionId, operationId,
      action, requestHash: hash, input, allocatedItemId: `${action.includes('grammar') ? 'grammar-chinese' : 'zh-integration'}-${randomUUID()}`,
      status: 'queued', stage: 'validating', attempt: 0, generation: 0, leaseUntil: 0, coreCommitted: false,
      createdAt: timestamp, updatedAt: timestamp, expiresAt: timestamp + 30 * 86400000,
    };
    return this.db.runTransaction(async tx => {
      const old = (await tx.get(ref)).data() as IntegrationOperation | undefined;
      if (old) {
        if (old.requestHash !== hash || old.action !== action) throw new OperationConflict('IDEMPOTENCY_CONFLICT');
        if (old.expiresAt <= timestamp) throw new OperationConflict('OPERATION_EXPIRED');
        return old;
      }
      tx.create(ref, candidate);
      tx.create(this.db.collection('integration_dispatch_outbox').doc(ref.id), {
        operationRef: ref.path, generation: 0, nextWakeAt: timestamp, createdAt: timestamp,
      });
      return candidate;
    });
  }
  async get(principal: IntegrationPrincipal, operationId: string): Promise<IntegrationOperation | null> {
    const value = (await this.ref(principal, operationId).get()).data() as IntegrationOperation | undefined;
    return value && value.principalId === principal.id && value.expiresAt > this.now() ? value : null;
  }
  async claim(principal: IntegrationPrincipal, operationId: string, leaseMs = 660000): Promise<IntegrationOperation | null> {
    const ref = this.ref(principal, operationId);
    return this.db.runTransaction(async tx => {
      const value = (await tx.get(ref)).data() as IntegrationOperation | undefined;
      const timestamp = this.now();
      if (!value || value.expiresAt <= timestamp || value.status === 'succeeded' || value.status === 'failed'
        || value.status === 'running' && value.leaseUntil > timestamp) return null;
      const claimed: IntegrationOperation = { ...value, status: 'running', generation: value.generation + 1,
        attempt: value.attempt + 1, leaseUntil: timestamp + leaseMs, updatedAt: timestamp };
      tx.set(ref, claimed);
      return claimed;
    });
  }
  /** Domain writes and the receipt share ONE transaction. Domain callback must read before writing and never call an LLM. */
  async commitCore(principal: IntegrationPrincipal, operationId: string, generation: number,
    write: (tx: Transaction, operation: IntegrationOperation) => Promise<Record<string, unknown>>) {
    const ref = this.ref(principal, operationId);
    return this.db.runTransaction(async tx => {
      const value = (await tx.get(ref)).data() as IntegrationOperation | undefined;
      if (!value || value.generation !== generation || value.status !== 'running' || value.leaseUntil <= this.now()) throw new OperationConflict('LEASE_LOST');
      if (value.coreCommitted) return value.result!;
      const result = await write(tx, value);
      tx.update(ref, { coreCommitted: true, stage: 'reconciling', result, updatedAt: this.now() });
      return result;
    });
  }
  async complete(principal: IntegrationPrincipal, operationId: string, generation: number) {
    const ref = this.ref(principal, operationId);
    await this.db.runTransaction(async tx => {
      const value = (await tx.get(ref)).data() as IntegrationOperation | undefined;
      if (!value || value.generation !== generation || value.status !== 'running' || !value.coreCommitted || value.leaseUntil <= this.now()) throw new OperationConflict('LEASE_LOST');
      tx.update(ref, { status: 'succeeded', leaseUntil: 0, updatedAt: this.now() });
      tx.delete(this.db.collection('integration_dispatch_outbox').doc(ref.id));
    });
  }
}
