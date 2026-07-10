import 'reflect-metadata';
import {
  type DrizzleTxCapable,
  type DrizzleTxError,
  err,
  ok,
  Propagation,
  type Result,
} from '@drizzle-tx/core';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { expect, it } from 'vitest';
import { DrizzleTransactionModule } from '../../src/drizzle-transaction.module.js';
import { createNoOpTransactionManager } from '../../src/testing.js';
import { DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER } from '../../src/tokens.js';
import { TransactionHost } from '../../src/transaction-host.js';
import { Transactional } from '../../src/transactional.decorator.js';

// Seam 2 (per docs/prds — issue #1 Testing Decisions): drive the REAL @Transactional
// decorator + DI graph through the `@drizzle-tx/nestjs/testing` override helper, with NO
// Postgres. The runner is still the nestjs SWC project (so decorator metadata survives),
// but nothing here touches a database — the no-op adapter issues no SQL.

/** A recording mock that satisfies the fluent shape `Repo.add` calls — no database. */
function makeMockClient() {
  const inserts: string[] = [];
  const client = {
    insert(_table: string) {
      return {
        values(v: { name: string }) {
          return {
            async returning() {
              inserts.push(v.name);
              return [{ id: inserts.length, name: v.name }];
            },
          };
        },
      };
    },
  };
  return { client, inserts };
}

@Injectable()
class Repo {
  // biome-ignore lint/suspicious/noExplicitAny: transactional client is structurally typed in tests
  constructor(@Inject(DRIZZLE_TX_CLIENT) private readonly db: any) {}
  add(name: string) {
    return this.db.insert('users').values({ name }).returning();
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
    await this.repo.add(name); // rolled back (no real SQL, so the mock still records it)
    await this.audit(`${name}-audit`); // self-invocation → REQUIRES_NEW → independent boundary
    return err('fail');
  }

  @Transactional(Propagation.RequiresNew)
  async audit(name: string): Promise<Result<null, DrizzleTxError>> {
    await this.repo.add(name);
    return ok(null);
  }

  @Transactional()
  async outerNested(name: string): Promise<Result<null, 'fail' | DrizzleTxError>> {
    await this.repo.add(name);
    await this.nestedStep(`${name}-child`); // NESTED → savepoint-style boundary
    return ok(null);
  }

  @Transactional(Propagation.Nested)
  async nestedStep(name: string): Promise<Result<null, DrizzleTxError>> {
    await this.repo.add(name);
    return ok(null);
  }
}

async function boot() {
  const { client, inserts } = makeMockClient();
  const manager = createNoOpTransactionManager(client);
  const ref = await Test.createTestingModule({
    // The base drizzle instance is never consumed once DRIZZLE_TX_MANAGER is overridden.
    imports: [DrizzleTransactionModule.forRoot({ drizzle: {} as unknown as DrizzleTxCapable })],
    providers: [Repo, Service],
  })
    .overrideProvider(DRIZZLE_TX_MANAGER)
    .useValue(manager)
    .compile();
  await ref.init();
  return { ref, manager, client, inserts };
}

it('REQUIRED ok: commits one boundary; the injected client hits the mock', async () => {
  const { ref, manager, inserts } = await boot();
  const r = await ref.get(Service).createTwo('a', 'b');
  expect(r).toEqual({ ok: true, value: 2 });
  expect(inserts).toEqual(['a', 'b']); // injected DRIZZLE_TX_CLIENT resolved to the no-op client
  expect(manager.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'commit' }]);
  await ref.close();
});

it('REQUIRED err: records a rollback boundary and returns the domain error faithfully', async () => {
  const { ref, manager, inserts } = await boot();
  const r = await ref.get(Service).createThenFail('x');
  expect(r).toEqual({ ok: false, error: 'fail' });
  expect(inserts).toEqual(['x']); // no real rollback — the no-op issues no SQL
  expect(manager.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'rollback' }]);
  await ref.close();
});

it('REQUIRES_NEW self-invocation records an independent boundary before the outer rollback', async () => {
  const { ref, manager } = await boot();
  const r = await ref.get(Service).outerWithAudit('main');
  expect(r).toEqual({ ok: false, error: 'fail' });
  expect(manager.getBoundaryLog()).toEqual([
    { kind: 'new-root', outcome: 'commit' }, // audit committed independently
    { kind: 'new-root', outcome: 'rollback' }, // outer rolled back
  ]);
  await ref.close();
});

it('NESTED records a nested boundary in order; resetBoundaryLog clears it between cases', async () => {
  const { ref, manager } = await boot();
  const r = await ref.get(Service).outerNested('main');
  expect(r).toEqual({ ok: true, value: null });
  expect(manager.getBoundaryLog()).toEqual([
    { kind: 'nested', outcome: 'commit' }, // inner NESTED resolves first
    { kind: 'new-root', outcome: 'commit' }, // outer REQUIRED resolves after
  ]);
  manager.resetBoundaryLog();
  expect(manager.getBoundaryLog()).toEqual([]);
  await ref.close();
});

it('override cascades to TransactionHost: host.tx resolves to the no-op client', async () => {
  const { ref, client } = await boot();
  expect(ref.get(TransactionHost).tx).toBe(client);
  await ref.close();
});
