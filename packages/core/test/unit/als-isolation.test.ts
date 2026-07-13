import { describe, expect, it } from 'vitest';
import type { TransactionAdapter } from '../../src/adapters/port.js';
import { ok } from '../../src/result.js';
import { TransactionManager } from '../../src/transaction-manager.js';

// A fake adapter that hands a FRESH client per boundary — required to prove isolation
// (NoOp reuses one client). Each wrapWithTransaction runs work with a unique {id}.
class DistinctClientAdapter implements TransactionAdapter<{ id: number }> {
  supportsIndependentTransactions = true;
  #n = 0;
  #base = { id: 0 };
  getBaseClient() {
    return this.#base;
  }
  async wrapWithTransaction<T>(_o: unknown, work: (tx: { id: number }) => Promise<T>) {
    return work({ id: ++this.#n });
  }
  async wrapWithNestedTransaction<T>(_p: { id: number }, work: (sp: { id: number }) => Promise<T>) {
    return work({ id: ++this.#n });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ALS isolation under concurrency', () => {
  it('concurrent withTransaction flows never share a tx client (no ALS bleed)', async () => {
    const m = new TransactionManager(new DistinctClientAdapter(), { logger: { warn() {} } });
    const seen: number[] = [];

    const oneFlow = () =>
      m.withTransaction(async () => {
        const first = (m.getTransactionClient() as { id: number }).id;
        await tick(); // yield — interleave with the other flows
        await tick();
        const afterYield = (m.getTransactionClient() as { id: number }).id;
        expect(afterYield).toBe(first); // this flow's client is STABLE across awaits
        seen.push(first);
        return ok(first);
      });

    const results = await Promise.all([oneFlow(), oneFlow(), oneFlow(), oneFlow(), oneFlow()]);
    // every flow committed, each saw its OWN client id, and all ids are pairwise distinct:
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(seen).size).toBe(5);
  });

  it('outside any transaction, getTransactionClient() is the base client and isActive is false', async () => {
    const m = new TransactionManager(new DistinctClientAdapter(), { logger: { warn() {} } });
    expect(m.isTransactionActive()).toBe(false);
    expect((m.getTransactionClient() as { id: number }).id).toBe(0); // base
    // a completed tx leaves no residue:
    await m.withTransaction(async () => ok(null));
    expect(m.isTransactionActive()).toBe(false);
  });
});
