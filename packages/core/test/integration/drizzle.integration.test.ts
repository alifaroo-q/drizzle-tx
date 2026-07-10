import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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

it('commits: row is visible on a SEPARATE connection after success', async () => {
  const result = await manager.withTransaction(async () => {
    const client = manager.getTransactionClient();
    const [u] = await client.insert(users).values({ name: 'Committed' }).returning();
    return ok(u);
  });
  expect(result.ok).toBe(true);

  const other = new Pool({ connectionString: t.pool.options.connectionString });
  const seen = await other.query('SELECT name FROM users WHERE name = $1', ['Committed']);
  await other.end();
  expect(seen.rowCount).toBe(1);
});

it('rolls back: row is ABSENT after work returns err', async () => {
  const result = await manager.withTransaction(async () => {
    const client = manager.getTransactionClient();
    await client.insert(users).values({ name: 'RolledBack' });
    return { ok: false as const, error: 'nope' as const };
  });
  expect(result).toEqual({ ok: false, error: 'nope' });

  const rows = await t.pool.query('SELECT * FROM users WHERE name = $1', ['RolledBack']);
  expect(rows.rowCount).toBe(0);
});

it('isolation: base client cannot see uncommitted rows written inside the tx', async () => {
  await manager.withTransaction(async () => {
    const txClient = manager.getTransactionClient();
    await txClient.insert(users).values({ name: 'Uncommitted' });
    // Read via the BASE client (separate connection) — must not see it.
    const viaBase = await t.db.select().from(users).where(eq(users.name, 'Uncommitted'));
    expect(viaBase).toEqual([]);
    return ok(null);
  });
});

it('forwards isolationLevel to Drizzle on a NEW top-level transaction', async () => {
  const spy = vi.spyOn(t.db, 'transaction');
  const result = await manager.withTransaction({ isolationLevel: 'serializable' }, async () => {
    await manager.getTransactionClient().insert(users).values({ name: 'Serial' });
    return ok(null);
  });
  expect(result.ok).toBe(true);
  // The option must reach db.transaction(cb, { isolationLevel: 'serializable' }).
  expect(spy).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'serializable' });
});
