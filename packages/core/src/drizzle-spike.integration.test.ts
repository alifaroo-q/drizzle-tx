import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { accounts, users } from '../../../test/schema.js';
import { createTestDb, type TestDb } from '../../../vitest.dbPerWorker.js';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

it('insert + select round-trips on real Postgres', async () => {
  const [u] = await t.db.insert(users).values({ name: 'Ada' }).returning();
  if (!u) throw new Error('insert returned no row');
  expect(u).toMatchObject({ id: expect.any(Number), name: 'Ada' });

  const found = await t.db.select().from(users).where(eq(users.id, u.id));
  expect(found).toEqual([{ id: u.id, name: 'Ada' }]);
});

it('db.query relations v2 loads related rows', async () => {
  const [u] = await t.db.insert(users).values({ name: 'Grace' }).returning();
  if (!u) throw new Error('insert returned no row');
  await t.db.insert(accounts).values({ userId: u.id, balance: 100 });

  const withAccounts = await t.db.query.users.findFirst({
    where: { id: u.id },
    with: { accounts: true },
  });
  expect(withAccounts).toMatchObject({ name: 'Grace', accounts: [{ balance: 100 }] });
});
