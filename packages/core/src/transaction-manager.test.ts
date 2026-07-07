import { describe, expect, it, vi } from 'vitest';
import type { TransactionAdapter } from './adapter.js';
import { Propagation } from './propagation.js';
import { err, ok } from './result.js';
import { TransactionManager } from './transaction-manager.js';

/** Fake client is just a tagged object; a new tag per BEGIN so we can assert identity. */
type FakeClient = { readonly tag: string };

function makeFakeAdapter(opts?: { supportsIndependent?: boolean }): {
  adapter: TransactionAdapter<FakeClient>;
  begins: string[];
  savepoints: string[];
  commits: string[];
  rollbacks: string[];
} {
  const base: FakeClient = { tag: 'base' };
  const begins: string[] = [];
  const savepoints: string[] = [];
  const commits: string[] = [];
  const rollbacks: string[] = [];
  let counter = 0;
  const adapter: TransactionAdapter<FakeClient> = {
    getBaseClient: () => base,
    supportsIndependentTransactions: opts?.supportsIndependent ?? true,
    wrapWithTransaction: async (_options, setClient, work) => {
      const tx: FakeClient = { tag: `tx${++counter}` };
      begins.push(tx.tag);
      setClient(tx);
      // A resolved callback commits; a throw rolls back (drizzle semantics).
      try {
        const result = await work();
        commits.push(tx.tag);
        return result;
      } catch (e) {
        rollbacks.push(tx.tag);
        throw e;
      }
    },
    wrapWithNestedTransaction: async (_parent, setClient, work) => {
      const sp: FakeClient = { tag: `sp${++counter}` };
      savepoints.push(sp.tag);
      setClient(sp);
      return work();
    },
  };
  return { adapter, begins, savepoints, commits, rollbacks };
}

describe('TransactionManager', () => {
  it('getTransactionClient returns base client outside a transaction', () => {
    const { adapter } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    expect(m.getTransactionClient().tag).toBe('base');
    expect(m.isTransactionActive()).toBe(false);
  });

  it('REQUIRED starts a transaction and exposes the tx client to work', async () => {
    const { adapter, begins } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const result = await m.withTransaction(async () => {
      expect(m.isTransactionActive()).toBe(true);
      return ok(m.getTransactionClient().tag);
    });
    expect(result).toEqual({ ok: true, value: 'tx1' });
    expect(begins).toEqual(['tx1']);
  });

  it('REQUIRED returns err when work returns err (rollback path)', async () => {
    const { adapter } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const result = await m.withTransaction(async () => err('DOMAIN_FAIL' as const));
    expect(result).toEqual({ ok: false, error: 'DOMAIN_FAIL' });
  });

  it('wraps an unexpected throw as TransactionAborted (never rethrows)', async () => {
    const { adapter } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const boom = new Error('kaboom');
    const result = await m.withTransaction(async () => {
      throw boom;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'TransactionAborted', cause: boom });
    }
  });

  it('REQUIRED joins an existing transaction (no second BEGIN)', async () => {
    const { adapter, begins } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    await m.withTransaction(async () => {
      const outerTag = m.getTransactionClient().tag;
      const inner = await m.withTransaction(Propagation.Required, async () =>
        ok(m.getTransactionClient().tag),
      );
      expect(inner).toEqual({ ok: true, value: outerTag }); // same client
      return ok(null);
    });
    expect(begins).toEqual(['tx1']); // only one BEGIN
  });

  it('REQUIRES_NEW starts an independent transaction even when active', async () => {
    const { adapter, begins } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    await m.withTransaction(async () => {
      await m.withTransaction(Propagation.RequiresNew, async () => ok(null));
      return ok(null);
    });
    expect(begins).toEqual(['tx1', 'tx2']); // two independent BEGINs
  });

  it('REQUIRES_NEW while active returns err(NotPoolBacked) when adapter cannot', async () => {
    const { adapter } = makeFakeAdapter({ supportsIndependent: false });
    const m = new TransactionManager(adapter);
    // The outer work must WRAP the inner result in ok(), otherwise returning the
    // inner err directly would roll the OUTER back (err is the rollback signal).
    const result = await m.withTransaction(async () => {
      const inner = await m.withTransaction(Propagation.RequiresNew, async () => ok('inner'));
      return ok(inner);
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ ok: false, error: { kind: 'NotPoolBacked' } });
  });

  it('NESTED uses a savepoint when active', async () => {
    const { adapter, savepoints } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    await m.withTransaction(async () => {
      await m.withTransaction(Propagation.Nested, async () => ok(m.getTransactionClient().tag));
      return ok(null);
    });
    expect(savepoints).toEqual(['sp2']);
  });

  it('NESTED with no active transaction starts a top-level one', async () => {
    const { adapter, begins, savepoints } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    await m.withTransaction(Propagation.Nested, async () => ok(null));
    expect(begins).toEqual(['tx1']);
    expect(savepoints).toEqual([]);
  });

  it('warns and strips tx options when joining REQUIRED / NESTED', async () => {
    const { adapter } = makeFakeAdapter();
    const warn = vi.fn();
    const m = new TransactionManager(adapter, { logger: { warn } });
    await m.withTransaction(async () => {
      await m.withTransaction(Propagation.Nested, { isolationLevel: 'serializable' }, async () =>
        ok(null),
      );
      return ok(null);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });
});

describe('TransactionManager.begin (scope-based / AsyncDisposable)', () => {
  it('begin() opens a transaction and exposes the tx client', async () => {
    const { adapter, begins } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const opened = await m.begin();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.tx.tag).toBe('tx1');
    expect(begins).toEqual(['tx1']);
    opened.value.commit();
    await opened.value[Symbol.asyncDispose]();
  });

  it('commit() then dispose COMMITS', async () => {
    const { adapter, commits, rollbacks } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const opened = await m.begin();
    if (!opened.ok) throw new Error('expected ok');
    opened.value.commit();
    await opened.value[Symbol.asyncDispose]();
    expect(commits).toEqual(['tx1']);
    expect(rollbacks).toEqual([]);
  });

  it('dispose WITHOUT commit rolls back (default-deny)', async () => {
    const { adapter, commits, rollbacks } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const opened = await m.begin();
    if (!opened.ok) throw new Error('expected ok');
    // no commit() call
    await opened.value[Symbol.asyncDispose]();
    expect(commits).toEqual([]);
    expect(rollbacks).toEqual(['tx1']);
  });

  it('explicit rollback() after commit() wins (last decision before dispose)', async () => {
    const { adapter, commits, rollbacks } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const opened = await m.begin();
    if (!opened.ok) throw new Error('expected ok');
    opened.value.commit();
    opened.value.rollback();
    await opened.value[Symbol.asyncDispose]();
    expect(commits).toEqual([]);
    expect(rollbacks).toEqual(['tx1']);
  });

  it('returns err(NotPoolBacked) as a value when the transaction cannot start', async () => {
    // Adapter whose wrapWithTransaction rejects before running the work callback.
    const failing: TransactionAdapter<FakeClient> = {
      getBaseClient: () => ({ tag: 'base' }),
      supportsIndependentTransactions: false,
      wrapWithTransaction: () => Promise.reject(new Error('cannot start')),
      wrapWithNestedTransaction: (_p, _s, work) => work(),
    };
    const m = new TransactionManager(failing);
    const opened = await m.begin();
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.kind).toBe('TransactionAborted');
  });
});
