import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { users } from '../../../../test/schema.js';
import { createTestDb, type TestDb } from '../../../../vitest.dbPerWorker.js';
import { DrizzleAdapter } from '../../src/adapters/drizzle.js';
import { Propagation } from '../../src/propagation.js';
import { err, ok, settle } from '../../src/result.js';
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

it('REQUIRED → NESTED → NESTED: inner savepoint rollback keeps outer work', async () => {
  const r = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'root' });
    const inner = await manager.withTransaction(Propagation.Nested, async () => {
      await db.insert(users).values({ name: 'sp1' });
      const innermost = await manager.withTransaction(Propagation.Nested, async () => {
        await db.insert(users).values({ name: 'sp2' });
        return err({ kind: 'RollbackInnermost' } as const); // rolls back sp2 only
      });
      expect(innermost.ok).toBe(false);
      return ok('sp1-kept'); // sp1 + root commit
    });
    expect(inner).toEqual({ ok: true, value: 'sp1-kept' });
    return ok(null);
  });
  expect(r.ok).toBe(true);
  const names = (await db.select().from(users)).map((u: { name: string }) => u.name).sort();
  expect(names).toEqual(['root', 'sp1']); // sp2 rolled back; root + sp1 survive
});

it('REQUIRED → NESTED → REQUIRES_NEW: independent inner commits even when the outer rolls back', async () => {
  const r = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'outer' });
    const indep = await manager.withTransaction(Propagation.Nested, async () => {
      // REQUIRES_NEW yields a branded `Independent` (Plan C) — `settle()` is the conscious
      // escape to propagate its outcome as this NESTED work's result (a bare `return inner`
      // is blocked by the brand's poison).
      const inner = await manager.withTransaction(Propagation.RequiresNew, async () => {
        await db.insert(users).values({ name: 'independent' }); // own connection/tx
        return ok('committed-independently');
      });
      return settle(inner);
    });
    expect(indep.ok).toBe(true);
    return err({ kind: 'RollbackOuter' } as const); // outer (+ its savepoint) roll back
  });
  expect(r.ok).toBe(false);
  // the REQUIRES_NEW row persisted on its own connection; 'outer' rolled back:
  const names = (await db.select().from(users)).map((u: { name: string }) => u.name).sort();
  expect(names).toEqual(['independent']);
}, 10000);
