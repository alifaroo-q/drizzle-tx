import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { users } from '../../../../test/schema.js';
import { createTestDb, type TestDb } from '../../../../vitest.dbPerWorker.js';
import { DrizzleAdapter } from '../../src/adapters/drizzle.js';
import { ok } from '../../src/result.js';
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

it('N concurrent transactions are isolated and each proxy auto-joins its own tx', async () => {
  const names = ['a', 'b', 'c', 'd', 'e'];

  // Barrier: hold every flow open (uncommitted) until ALL have inserted, so each SELECT runs
  // while the others' rows are still uncommitted. Under READ COMMITTED a foreign UNCOMMITTED
  // row is invisible — so "sees only its own row" proves both isolation AND correct auto-join
  // (a select that saw another flow's row would mean the proxy joined the wrong tx or ALS bled).
  let insertedCount = 0;
  let releaseBarrier!: () => void;
  const allInserted = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  const results = await Promise.all(
    names.map((name) =>
      manager.withTransaction(async () => {
        await db.insert(users).values({ name }); // proxy auto-joins THIS tx
        if (++insertedCount === names.length) releaseBarrier();
        await allInserted; // park until all N flows are inserted-but-uncommitted
        // every flow is now open and uncommitted → this tx must see ONLY its own row:
        const mine = await db.select().from(users);
        expect(mine.map((r: { name: string }) => r.name)).toEqual([name]);
        return ok(name);
      }),
    ),
  );
  expect(results.every((r) => r.ok)).toBe(true);
  // after all commit, all five rows are present exactly once:
  const all = await db.select().from(users);
  expect(all.map((r: { name: string }) => r.name).sort()).toEqual(names);
}, 10000);
