import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { users } from '../../../../test/schema.js';
import { createTestDb, type TestDb } from '../../../../vitest.dbPerWorker.js';
import { DrizzleAdapter } from '../../src/adapters/drizzle.js';
import { ok } from '../../src/result.js';
import { TransactionManager } from '../../src/transaction-manager.js';

let t: TestDb;
// biome-ignore lint/suspicious/noExplicitAny: transactional client is structurally typed in tests
let manager: TransactionManager<any>;

beforeAll(async () => {
  t = await createTestDb();
  manager = new TransactionManager(new DrizzleAdapter({ db: t.db }), {
    logger: { warn: () => {} },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.pool.query('TRUNCATE users RESTART IDENTITY CASCADE');
});

it('await using + commit(): the row persists', async () => {
  const opened = await manager.begin();
  expect(opened.ok).toBe(true);
  if (opened.ok) {
    await using scope = opened.value;
    await scope.tx.insert(users).values({ name: 'Committed' });
    scope.commit();
  } // dispose here → COMMIT

  const rows = await t.pool.query('SELECT name FROM users');
  expect(rows.rows).toEqual([{ name: 'Committed' }]);
});

it('await using WITHOUT commit(): rolls back (default-deny)', async () => {
  const opened = await manager.begin();
  if (!opened.ok) throw new Error('expected ok');
  {
    await using scope = opened.value;
    await scope.tx.insert(users).values({ name: 'Ghost' });
    // no commit()
  } // dispose here → ROLLBACK

  const rows = await t.pool.query('SELECT * FROM users');
  expect(rows.rowCount).toBe(0);
});

it('early return inside the scope rolls back', async () => {
  const attempt = async (): Promise<string> => {
    const opened = await manager.begin();
    if (!opened.ok) return 'infra-error';
    await using scope = opened.value;
    await scope.tx.insert(users).values({ name: 'MaybeGone' });
    return 'left-early'; // scope disposes on return → ROLLBACK (never committed)
  };
  expect(await attempt()).toBe('left-early');

  const rows = await t.pool.query('SELECT * FROM users');
  expect(rows.rowCount).toBe(0);
});

it('the scope commit is visible on a separate connection', async () => {
  const opened = await manager.begin();
  if (!opened.ok) throw new Error('expected ok');
  {
    await using scope = opened.value;
    await scope.tx.insert(users).values({ name: 'CrossConn' });
    scope.commit();
  }
  // Read via the base pool (separate connection) — must see the committed row.
  const seen = await t.pool.query('SELECT name FROM users WHERE name = $1', ['CrossConn']);
  expect(seen.rowCount).toBe(1);
});

it('R5: an un-disposed scope is reclaimed after disposeTimeoutMs (connection released)', async () => {
  const small = await createTestDb(1); // pool max 1 → the scope holds the ONLY connection
  const m = new TransactionManager(new DrizzleAdapter({ db: small.db }), {
    logger: { warn: () => {} },
  });
  try {
    const opened = await m.begin({ disposeTimeoutMs: 500 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // Deliberately DO NOT dispose — simulate a forgotten scope pinning the connection.
    // The backstop (500ms) fires < the pool's 3s connectionTimeout, freeing the connection so a
    // fresh tx can acquire it instead of deadlocking:
    const r = await m.withTransaction(async () => ok('reclaimed'));
    expect(r).toEqual({ ok: true, value: 'reclaimed' });
  } finally {
    await small.close();
  }
}, 10000);
