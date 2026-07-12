import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { accounts, users } from '../../../../test/schema.js';
import { createTestDb, type TestDb } from '../../../../vitest.dbPerWorker.js';
import { DrizzleAdapter } from '../../src/adapters/drizzle.js';
import { Propagation } from '../../src/propagation.js';
import { err, ok } from '../../src/result.js';
import { TransactionManager } from '../../src/transaction-manager.js';
import { createTransactionalClient } from '../../src/transactional-client.js';

let t: TestDb;
// biome-ignore lint/suspicious/noExplicitAny: transactional client is structurally typed in tests
let manager: TransactionManager<any>;
// biome-ignore lint/suspicious/noExplicitAny: the transactional client (proxy)
let db: any;

beforeAll(async () => {
  t = await createTestDb();
  manager = new TransactionManager(new DrizzleAdapter({ db: t.db }), {
    logger: { warn: () => {} },
  });
  db = createTransactionalClient(() => manager.getTransactionClient());
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.pool.query('TRUNCATE users, accounts RESTART IDENTITY CASCADE');
});

it('proxy auto-joins the tx for the query builder AND db.query relations', async () => {
  await manager.withTransaction(async () => {
    const [u] = await db.insert(users).values({ name: 'Ada' }).returning();
    await db.insert(accounts).values({ userId: u.id, balance: 50 });
    const loaded = await db.query.users.findFirst({
      where: { id: u.id },
      with: { accounts: true },
    });
    expect(loaded).toMatchObject({ name: 'Ada', accounts: [{ balance: 50 }] });
    return ok(null);
  });
  // committed & visible outside the tx via the same proxy (now hitting base client)
  const all = await db.select().from(users);
  expect(all).toHaveLength(1);
});

it('REQUIRES_NEW inner COMMITS even when the outer rolls back', async () => {
  const outer = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'OuterUser' });
    await manager.withTransaction(Propagation.RequiresNew, async () => {
      await db.insert(users).values({ name: 'AuditUser' }); // independent connection
      return ok(null);
    });
    return err('outer-fails' as const); // rolls the OUTER back
  });
  expect(outer).toEqual({ ok: false, error: 'outer-fails' });

  const rows = await t.pool.query('SELECT name FROM users ORDER BY name');
  expect(rows.rows).toEqual([{ name: 'AuditUser' }]); // OuterUser gone, AuditUser survived
});

it('NESTED rolls back to its savepoint; the outer transaction still commits', async () => {
  const result = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'Keep' });
    await manager.withTransaction(Propagation.Nested, async () => {
      await db.insert(users).values({ name: 'Drop' });
      return err('inner-fails' as const); // rolls back only the savepoint
    });
    return ok(null); // outer commits
  });
  expect(result.ok).toBe(true);

  const rows = await t.pool.query('SELECT name FROM users ORDER BY name');
  expect(rows.rows).toEqual([{ name: 'Keep' }]);
});

it('REQUIRED join: a propagated inner err rolls back the whole transaction', async () => {
  const result = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'Outer' });
    // Inner REQUIRED joins the SAME transaction (no new BEGIN).
    const inner = await manager.withTransaction(Propagation.Required, async () => {
      await db.insert(users).values({ name: 'Inner' });
      return err('inner-fails' as const);
    });
    // Propagate the inner err → the outermost boundary throws → full rollback.
    return inner.ok ? ok(null) : inner;
  });
  expect(result).toEqual({ ok: false, error: 'inner-fails' });

  const rows = await t.pool.query('SELECT count(*)::int AS n FROM users');
  expect(rows.rows[0].n).toBe(0); // both Outer and Inner rolled back
});

it('pool exhaustion via REQUIRES_NEW FAILS FAST (does not hang)', async () => {
  // max:1 pool → the outer tx holds the only connection; REQUIRES_NEW cannot get one.
  const small = await createTestDb(1);
  const m = new TransactionManager(new DrizzleAdapter({ db: small.db }), {
    logger: { warn: () => {} },
  });
  try {
    const result = await m.withTransaction(async () => {
      // Wrap the inner result so the OUTER commits and surfaces the inner Result.
      const inner = await m.withTransaction(Propagation.RequiresNew, async () => ok('never'));
      return ok(inner);
    });
    // Must resolve (not hang) with an error, well under the pool's 3s connectionTimeout.
    expect(result.ok).toBe(true);
    if (result.ok) {
      const inner = result.value as { ok: boolean; error?: { kind: string } };
      expect(inner.ok).toBe(false);
      expect(['PoolConnectionTimeout', 'TransactionAborted']).toContain(inner.error?.kind);
    }
  } finally {
    await small.close();
  }
}, 10000);

it('R1: ok-returning work still errs when a DEFERRED constraint fails at COMMIT', async () => {
  // DDL via the raw pool (the proxy is for the query builder; DDL has no builder here).
  await t.pool.query(`CREATE TABLE IF NOT EXISTS r1_defer (id int PRIMARY KEY, ref int,
    CONSTRAINT r1_fk FOREIGN KEY (ref) REFERENCES r1_defer(id) DEFERRABLE INITIALLY DEFERRED)`);
  try {
    const r = await manager.withTransaction(async () => {
      await db.execute(sql`INSERT INTO r1_defer (id, ref) VALUES (1, 999)`); // ref 999 absent
      return ok('inserted'); // work says commit — COMMIT then fails on the deferred FK
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 23503 foreign_key_violation isn't in a named-variant class → TransactionAborted, sqlState carried:
    expect(r.error).toMatchObject({ kind: 'TransactionAborted', sqlState: '23503' });
  } finally {
    await t.pool.query('DROP TABLE IF EXISTS r1_defer');
  }
});
