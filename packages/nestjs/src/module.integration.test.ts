import 'reflect-metadata';
import { err, ok } from '@drizzle-tx/core';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { users } from '../../../test/schema.js';
import { createTestDb, type TestDb } from '../../../vitest.dbPerWorker.js';
import { DrizzleTransactionModule } from './drizzle-transaction.module.js';
import { DRIZZLE_TX_CLIENT } from './tokens.js';
import { TransactionHost } from './transaction-host.js';

let t: TestDb;

@Injectable()
class UserRepo {
  // biome-ignore lint/suspicious/noExplicitAny: transactional client is structurally typed in tests
  constructor(@Inject(DRIZZLE_TX_CLIENT) private readonly db: any) {}
  create(name: string) {
    return this.db.insert(users).values({ name }).returning();
  }
}

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.pool.query('TRUNCATE users RESTART IDENTITY CASCADE');
});

async function bootstrap() {
  const moduleRef = await Test.createTestingModule({
    imports: [DrizzleTransactionModule.forRoot({ drizzle: t.db })],
    providers: [UserRepo],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

it('injects a tx-aware client and commits via withTransaction', async () => {
  const app = await bootstrap();
  const host = app.get(TransactionHost);
  const repo = app.get(UserRepo);

  const result = await host.withTransaction(async () => {
    const [u] = await repo.create('Tx');
    return ok(u);
  });
  expect(result.ok).toBe(true);

  const rows = await t.pool.query('SELECT name FROM users');
  expect(rows.rows).toEqual([{ name: 'Tx' }]);
  await app.close();
});

it('rolls back when withTransaction work returns err', async () => {
  const app = await bootstrap();
  const host = app.get(TransactionHost);
  const repo = app.get(UserRepo);

  const result = await host.withTransaction(async () => {
    await repo.create('Ghost');
    return err({ kind: 'HostNotInitialized', connectionName: undefined } as const);
  });
  expect(result.ok).toBe(false);

  const rows = await t.pool.query('SELECT * FROM users');
  expect(rows.rowCount).toBe(0);
  await app.close();
});
