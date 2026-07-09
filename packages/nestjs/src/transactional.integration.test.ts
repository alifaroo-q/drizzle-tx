import 'reflect-metadata';
import { type DrizzleTxError, err, ok, Propagation, type Result } from '@drizzle-tx/core';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { users } from '../../../test/schema.js';
import { createTestDb, type TestDb } from '../../../vitest.dbPerWorker.js';
import { DrizzleTransactionModule } from './drizzle-transaction.module.js';
import { DRIZZLE_TX_CLIENT } from './tokens.js';
import { Transactional } from './transactional.decorator.js';

let t: TestDb;

@Injectable()
class Repo {
  // biome-ignore lint/suspicious/noExplicitAny: transactional client is structurally typed in tests
  constructor(@Inject(DRIZZLE_TX_CLIENT) private readonly db: any) {}
  add(name: string) {
    return this.db.insert(users).values({ name }).returning();
  }
}

@Injectable()
class Service {
  constructor(private readonly repo: Repo) {}

  @Transactional()
  async createTwo(a: string, b: string): Promise<Result<number, 'fail' | DrizzleTxError>> {
    await this.repo.add(a);
    await this.repo.add(b);
    return ok(2);
  }

  @Transactional()
  async createThenFail(name: string): Promise<Result<never, 'fail' | DrizzleTxError>> {
    await this.repo.add(name);
    return err('fail');
  }

  @Transactional()
  async outerWithAudit(name: string): Promise<Result<null, 'fail' | DrizzleTxError>> {
    await this.repo.add(name); // rolled back
    await this.audit(`${name}-audit`); // self-invocation → REQUIRES_NEW, commits
    return err('fail');
  }

  @Transactional(Propagation.RequiresNew)
  async audit(name: string): Promise<Result<null, DrizzleTxError>> {
    await this.repo.add(name);
    return ok(null);
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

async function boot() {
  const ref = await Test.createTestingModule({
    imports: [DrizzleTransactionModule.forRoot({ drizzle: t.db })],
    providers: [Repo, Service],
  }).compile();
  await ref.init();
  return ref;
}

it('commits both rows on success', async () => {
  const ref = await boot();
  const r = await ref.get(Service).createTwo('a', 'b');
  expect(r).toEqual({ ok: true, value: 2 });
  expect((await t.pool.query('SELECT count(*) FROM users')).rows[0].count).toBe('2');
  await ref.close();
});

it('rolls back all rows when the method returns err', async () => {
  const ref = await boot();
  const r = await ref.get(Service).createThenFail('x');
  expect(r).toEqual({ ok: false, error: 'fail' });
  expect((await t.pool.query('SELECT count(*) FROM users')).rows[0].count).toBe('0');
  await ref.close();
});

it('self-invocation: REQUIRES_NEW audit survives an outer rollback', async () => {
  const ref = await boot();
  const r = await ref.get(Service).outerWithAudit('main');
  expect(r).toEqual({ ok: false, error: 'fail' });
  const rows = await t.pool.query('SELECT name FROM users');
  expect(rows.rows).toEqual([{ name: 'main-audit' }]); // outer 'main' gone; audit survived
  await ref.close();
});
