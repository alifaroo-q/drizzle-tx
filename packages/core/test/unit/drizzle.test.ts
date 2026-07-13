import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DrizzleAdapter,
  type DrizzleTxCapable,
  PoolTimeoutError,
} from '../../src/adapters/drizzle.js';
import type { TxOptions } from '../../src/options.js';

/** A fake Drizzle client: `transaction` records the config it was called with and
 *  hands the client itself back as the tx (drizzle passes a tx-scoped clone; identity
 *  is all these tests need). */
function makeDb($client?: unknown): {
  db: DrizzleTxCapable;
  configs: (TxOptions | undefined)[];
} {
  const configs: (TxOptions | undefined)[] = [];
  const db = {
    $client,
    transaction: async (fn: (tx: unknown) => Promise<unknown>, config?: TxOptions) => {
      configs.push(config);
      return fn(db);
    },
  } as unknown as DrizzleTxCapable;
  return { db, configs };
}

describe('PoolTimeoutError', () => {
  it('carries the timeout it was constructed with', () => {
    expect(new PoolTimeoutError(5000).timeoutMs).toBe(5000);
    expect(new PoolTimeoutError(undefined).timeoutMs).toBeUndefined();
  });
});

describe('DrizzleAdapter', () => {
  it('getBaseClient returns the underlying db', () => {
    const { db } = makeDb();
    expect(new DrizzleAdapter({ db }).getBaseClient()).toBe(db);
  });

  describe('supportsIndependentTransactions (isPoolBacked)', () => {
    const pools: Pool[] = [];
    afterEach(async () => {
      await Promise.all(pools.splice(0).map((p) => p.end()));
    });

    it('is true when $client is a real pg Pool (instanceof)', () => {
      const pool = new Pool();
      pools.push(pool);
      const { db } = makeDb(pool);
      expect(new DrizzleAdapter({ db }).supportsIndependentTransactions).toBe(true);
    });

    it('is true via the structural fallback (totalCount/idleCount/connect)', () => {
      // A pg Pool from a duplicated module instance fails `instanceof` but is still a pool.
      const poolLike = { totalCount: 0, idleCount: 0, connect: () => {} };
      const { db } = makeDb(poolLike);
      expect(new DrizzleAdapter({ db }).supportsIndependentTransactions).toBe(true);
    });

    it('is false for a single client (no pool counters)', () => {
      // Shape of a bare pg.Client: has connect() but none of the pool-only counters.
      const clientLike = { connect: () => {}, query: () => {} };
      const { db } = makeDb(clientLike);
      expect(new DrizzleAdapter({ db }).supportsIndependentTransactions).toBe(false);
    });

    it('is false when $client is undefined or null', () => {
      expect(new DrizzleAdapter({ db: makeDb(undefined).db }).supportsIndependentTransactions).toBe(
        false,
      );
      expect(new DrizzleAdapter({ db: makeDb(null).db }).supportsIndependentTransactions).toBe(
        false,
      );
    });

    it('is false when counters are present but connect is not a function', () => {
      const notQuiteAPool = { totalCount: 0, idleCount: 0 };
      const { db } = makeDb(notQuiteAPool);
      expect(new DrizzleAdapter({ db }).supportsIndependentTransactions).toBe(false);
    });
  });

  describe('wrapWithTransaction', () => {
    it('forwards options to db.transaction and returns the work result', async () => {
      const { db, configs } = makeDb();
      const adapter = new DrizzleAdapter({ db });
      const options: TxOptions = { isolationLevel: 'serializable' };

      const result = await adapter.wrapWithTransaction(options, async (tx) => {
        expect(tx).toBe(db); // the tx client reaches the work callback
        return 'done';
      });

      expect(result).toBe('done');
      expect(configs).toEqual([options]);
    });

    it('maps a pg connection-timeout error to PoolTimeoutError', async () => {
      const db = {
        $client: undefined,
        transaction: async () => {
          throw new Error('timeout exceeded when trying to connect');
        },
      } as unknown as DrizzleTxCapable;
      const adapter = new DrizzleAdapter({ db });

      await expect(adapter.wrapWithTransaction(undefined, async () => 'x')).rejects.toBeInstanceOf(
        PoolTimeoutError,
      );
    });

    it('rethrows any other error unchanged', async () => {
      const boom = new Error('constraint violation');
      const db = {
        $client: undefined,
        transaction: async () => {
          throw boom;
        },
      } as unknown as DrizzleTxCapable;
      const adapter = new DrizzleAdapter({ db });

      await expect(adapter.wrapWithTransaction(undefined, async () => 'x')).rejects.toBe(boom);
    });
  });

  describe('wrapWithNestedTransaction', () => {
    it('opens a savepoint on the parent with NO options and returns the work result', async () => {
      const { db: parent, configs } = makeDb();
      const adapter = new DrizzleAdapter({ db: makeDb().db });

      const result = await adapter.wrapWithNestedTransaction(parent, async (sp) => {
        expect(sp).toBe(parent); // nested runs against the parent client
        return 'nested-done';
      });

      expect(result).toBe('nested-done');
      expect(configs).toEqual([undefined]); // isolation is fixed by the outer tx
    });
  });

  describe('PoolConnectionTimeout carries the configured timeout (R4)', () => {
    it('a pool-connect timeout carries the configured connectionTimeoutMillis (R4)', async () => {
      const fakeDb = {
        $client: { totalCount: 1, idleCount: 0, options: { connectionTimeoutMillis: 3000 } },
        transaction: async () => {
          throw new Error('timeout exceeded when trying to connect');
        },
      } as unknown as DrizzleTxCapable;

      const adapter = new DrizzleAdapter({ db: fakeDb });
      // (uses the imported PoolTimeoutError so the import isn't dead — assert the type AND the value)
      await expect(adapter.wrapWithTransaction(undefined, async () => 'x')).rejects.toBeInstanceOf(
        PoolTimeoutError,
      );
      await expect(adapter.wrapWithTransaction(undefined, async () => 'x')).rejects.toMatchObject({
        timeoutMs: 3000, // carries the CONFIGURED timeout, not the hard-coded undefined
      });
    });

    it('reports undefined when no finite connectionTimeoutMillis is configured', async () => {
      const fakeDb = {
        $client: { totalCount: 1, idleCount: 0, options: {} }, // pg default: wait forever
        transaction: async () => {
          throw new Error('timeout exceeded when trying to connect');
        },
      } as unknown as DrizzleTxCapable;
      await expect(
        new DrizzleAdapter({ db: fakeDb }).wrapWithTransaction(undefined, async () => 'x'),
      ).rejects.toMatchObject({ timeoutMs: undefined });
    });
  });
});
