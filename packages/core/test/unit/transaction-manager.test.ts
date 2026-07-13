import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoOpDrizzleAdapter } from '../../src/adapters/noop.js';
import type { TransactionAdapter } from '../../src/adapters/port.js';
import { Propagation } from '../../src/propagation.js';
import { err, ok } from '../../src/result.js';
import { TransactionManager } from '../../src/transaction-manager.js';

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
    wrapWithTransaction: async (_options, work) => {
      const tx: FakeClient = { tag: `tx${++counter}` };
      begins.push(tx.tag);
      // A resolved callback commits; a throw rolls back (drizzle semantics).
      try {
        const result = await work(tx);
        commits.push(tx.tag);
        return result;
      } catch (e) {
        rollbacks.push(tx.tag);
        throw e;
      }
    },
    wrapWithNestedTransaction: async (_parent, work) => {
      const sp: FakeClient = { tag: `sp${++counter}` };
      savepoints.push(sp.tag);
      return work(sp);
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

  it('warns about ignored options when a REQUIRED call joins an existing transaction', async () => {
    const { adapter, begins } = makeFakeAdapter();
    const warn = vi.fn();
    const m = new TransactionManager(adapter, { logger: { warn } });
    await m.withTransaction(async () => {
      await m.withTransaction(Propagation.Required, { isolationLevel: 'serializable' }, async () =>
        ok(null),
      );
      return ok(null);
    });
    expect(begins).toEqual(['tx1']); // joined, no second BEGIN
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('joining an existing transaction'));
  });
});

describe('TransactionManager — rollback double-fault (R2, ADR-0012 §2)', () => {
  // Adapter that lets work run, then throws a rollback-time failure that SHADOWS the RollbackSignal.
  class RollbackShadowAdapter implements TransactionAdapter<Record<string, never>> {
    supportsIndependentTransactions = true;
    getBaseClient() {
      return {};
    }
    async wrapWithTransaction<T>(
      _o: unknown,
      work: (tx: Record<string, never>) => Promise<T>,
    ): Promise<T> {
      await work({}).catch(() => {}); // work throws RollbackSignal(domainErr); swallow it
      throw Object.assign(new Error('ROLLBACK failed'), { code: '08006', severity: 'ERROR' });
    }
    async wrapWithNestedTransaction<T>(
      _p: Record<string, never>,
      work: (sp: Record<string, never>) => Promise<T>,
    ): Promise<T> {
      await work({}).catch(() => {});
      throw Object.assign(new Error('ROLLBACK TO SAVEPOINT failed'), {
        code: '08006',
        severity: 'ERROR',
      });
    }
  }

  it('infra error wins the channel, domain err preserved in lostDomainError', async () => {
    const m = new TransactionManager<Record<string, never>>(new RollbackShadowAdapter(), {
      logger: { warn() {} },
    });
    const domain = { kind: 'SoldOut' } as const;
    const r = await m.withTransaction(async () => err(domain));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // infra failure wins the channel (classified from the 08006 shadow), domain E preserved:
    expect(r.error).toMatchObject({ kind: 'ConnectionLost', lostDomainError: domain });
  });

  it('normal path: ROLLBACK succeeds → domain err returned faithfully, no lostDomainError', async () => {
    // NoOp-style adapter that re-throws whatever work threw (RollbackSignal survives)
    const m = new TransactionManager<Record<string, never>>(
      new (class implements TransactionAdapter<Record<string, never>> {
        supportsIndependentTransactions = true;
        getBaseClient() {
          return {};
        }
        async wrapWithTransaction<T>(_o: unknown, work: (tx: Record<string, never>) => Promise<T>) {
          return work({});
        }
        async wrapWithNestedTransaction<T>(
          _p: Record<string, never>,
          work: (sp: Record<string, never>) => Promise<T>,
        ) {
          return work({});
        }
      })(),
      { logger: { warn() {} } },
    );
    const r = await m.withTransaction(async () => err({ kind: 'SoldOut' } as const));
    expect(r).toEqual({ ok: false, error: { kind: 'SoldOut' } });
  });
});

describe('TransactionManager with NoOpDrizzleAdapter', () => {
  it('REQUIRED start commit + join emits one boundary and resolves the supplied client', async () => {
    const client = { tag: 'client' };
    const adapter = new NoOpDrizzleAdapter(client, { quiet: true });
    const m = new TransactionManager(adapter);

    const result = await m.withTransaction(async () => {
      expect(m.getTransactionClient()).toBe(client);
      const inner = await m.withTransaction(Propagation.Required, async () => {
        expect(m.getTransactionClient()).toBe(client);
        return ok(m.getTransactionClient().tag);
      });
      expect(inner).toEqual({ ok: true, value: 'client' });
      return ok(m.getTransactionClient().tag);
    });

    expect(result).toEqual({ ok: true, value: 'client' });
    expect(adapter.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'commit' }]);
  });

  it('REQUIRED start rollback returns domain err and records rollback boundary', async () => {
    const adapter = new NoOpDrizzleAdapter({ tag: 'client' }, { quiet: true });
    const m = new TransactionManager(adapter);

    const result = await m.withTransaction(async () => err('DOMAIN_FAIL' as const));

    expect(result).toEqual({ ok: false, error: 'DOMAIN_FAIL' });
    expect(adapter.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'rollback' }]);
  });

  it('REQUIRES_NEW while active records its own boundary and preserves inner domain err', async () => {
    const adapter = new NoOpDrizzleAdapter({ tag: 'client' }, { quiet: true });
    const m = new TransactionManager(adapter);

    const result = await m.withTransaction(async () => {
      const inner = await m.withTransaction(Propagation.RequiresNew, async () =>
        err('INNER_FAIL' as const),
      );
      return ok(inner);
    });

    expect(result).toEqual({ ok: true, value: { ok: false, error: 'INNER_FAIL' } });
    expect(adapter.getBoundaryLog()).toEqual([
      { kind: 'new-root', outcome: 'rollback' },
      { kind: 'new-root', outcome: 'commit' },
    ]);
  });

  it('REQUIRES_NEW while active commits its own boundary and resolves the supplied client', async () => {
    const client = { tag: 'client' };
    const adapter = new NoOpDrizzleAdapter(client, { quiet: true });
    const m = new TransactionManager(adapter);

    const result = await m.withTransaction(async () => {
      expect(m.getTransactionClient()).toBe(client);
      const inner = await m.withTransaction(Propagation.RequiresNew, async () => {
        expect(m.getTransactionClient()).toBe(client);
        return ok(m.getTransactionClient().tag);
      });
      expect(inner).toEqual({ ok: true, value: 'client' });
      return ok(inner);
    });

    expect(result).toEqual({ ok: true, value: { ok: true, value: 'client' } });
    expect(adapter.getBoundaryLog()).toEqual([
      { kind: 'new-root', outcome: 'commit' },
      { kind: 'new-root', outcome: 'commit' },
    ]);
  });

  it('NESTED while active records nested boundary outcomes for ok + err', async () => {
    const adapter = new NoOpDrizzleAdapter({ tag: 'client' }, { quiet: true });
    const m = new TransactionManager(adapter);

    const commitCase = await m.withTransaction(async () => {
      const nested = await m.withTransaction(Propagation.Nested, async () => ok('nested-ok'));
      return ok(nested);
    });
    expect(commitCase).toEqual({ ok: true, value: { ok: true, value: 'nested-ok' } });
    expect(adapter.getBoundaryLog()).toEqual([
      { kind: 'nested', outcome: 'commit' },
      { kind: 'new-root', outcome: 'commit' },
    ]);

    adapter.resetBoundaryLog();

    const rollbackCase = await m.withTransaction(async () => {
      const nested = await m.withTransaction(Propagation.Nested, async () =>
        err('NESTED_FAIL' as const),
      );
      return ok(nested);
    });
    expect(rollbackCase).toEqual({ ok: true, value: { ok: false, error: 'NESTED_FAIL' } });
    expect(adapter.getBoundaryLog()).toEqual([
      { kind: 'nested', outcome: 'rollback' },
      { kind: 'new-root', outcome: 'commit' },
    ]);
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
      wrapWithNestedTransaction: (_p, work) => work({ tag: 'base' }),
    };
    const m = new TransactionManager(failing);
    const opened = await m.begin();
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.kind).toBe('TransactionAborted');
  });
});

describe('TransactionManager.begin — disposeTimeoutMs resolution (R5, ADR-0014)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('begin() uses the manager-default disposeTimeoutMs; a per-call value overrides it', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const m = new TransactionManager<{}>(new NoOpDrizzleAdapter({}, { quiet: true }), {
      logger: { warn },
      disposeTimeoutMs: 1000,
    });

    const opened = await m.begin(); // inherits the manager default (1000)
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1000ms'));

    warn.mockClear();
    const opened2 = await m.begin({ disposeTimeoutMs: 200 }); // per-call overrides the default
    if (!opened2.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('200ms'));
  });

  it('begin() with no manager default and no per-call value arms no backstop', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const m = new TransactionManager<{}>(new NoOpDrizzleAdapter({}, { quiet: true }), {
      logger: { warn },
    });
    const opened = await m.begin();
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(warn).not.toHaveBeenCalled();
    await opened.value[Symbol.asyncDispose]();
  });
});
