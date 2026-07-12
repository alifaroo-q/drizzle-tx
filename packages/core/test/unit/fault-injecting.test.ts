import { describe, expect, it } from 'vitest';
import {
  FaultInjectingDrizzleAdapter,
  fakePgError,
  pgAdminShutdown,
  pgDeadlock,
  pgSerializationFailure,
  socketError,
} from '../../src/adapters/fault-injecting.js';
import { Propagation } from '../../src/propagation.js';
import { err, ok } from '../../src/result.js';
import { classifyCaught } from '../../src/rollback-boundary.js';
import { TransactionManager } from '../../src/transaction-manager.js';

const mgr = (a: FaultInjectingDrizzleAdapter<{}>) =>
  new TransactionManager<{}>(a, { logger: { warn() {} } });

describe('fault-injecting error helpers', () => {
  it('fakePgError carries a 5-char code + string severity (classifies structurally)', () => {
    const e = fakePgError('23505', 'dup key');
    expect(e).toMatchObject({ code: '23505', message: 'dup key', severity: expect.any(String) });
    // structural markers present → classifyCaught reads the SQLSTATE:
    expect(classifyCaught(e)).toMatchObject({ kind: 'TransactionAborted', sqlState: '23505' });
  });

  it('pgSerializationFailure → SerializationFailure(40001)', () => {
    expect(classifyCaught(pgSerializationFailure())).toMatchObject({
      kind: 'SerializationFailure',
      sqlState: '40001',
    });
  });

  it('pgDeadlock → DeadlockDetected(40P01)', () => {
    expect(classifyCaught(pgDeadlock())).toMatchObject({
      kind: 'DeadlockDetected',
      sqlState: '40P01',
    });
  });

  it('pgAdminShutdown → ConnectionLost(57P01)', () => {
    expect(classifyCaught(pgAdminShutdown())).toMatchObject({
      kind: 'ConnectionLost',
      sqlState: '57P01',
    });
  });

  it('socketError() (code-less) → ConnectionLost with undefined sqlState', () => {
    const e = socketError();
    expect(e).toBeInstanceOf(Error);
    expect((e as { code?: unknown }).code).toBeUndefined();
    expect(classifyCaught(e)).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
  });

  it('socketError({ code: "ECONNRESET" }) → ConnectionLost via socket-first precedence', () => {
    const e = socketError({ code: 'ECONNRESET' });
    expect((e as { syscall?: unknown }).syscall).toBeDefined();
    expect(classifyCaught(e)).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
  });
});

describe('FaultInjectingDrizzleAdapter — new-root', () => {
  it('warns once on construction unless quiet', () => {
    let n = 0;
    new FaultInjectingDrizzleAdapter(
      {},
      {
        logger: {
          warn: () => {
            n++;
          },
        },
      },
    );
    new FaultInjectingDrizzleAdapter(
      {},
      {
        logger: {
          warn: () => {
            n++;
          },
        },
        quiet: true,
      },
    );
    expect(n).toBe(1);
  });

  it('clean run: work ok → commit, boundary log has no failedAt', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { quiet: true });
    const r = await mgr(a).withTransaction(async () => ok('done'));
    expect(r).toEqual({ ok: true, value: 'done' });
    expect(a.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'commit' }]);
  });

  it('COMMIT fault (40001) after ok-work → SerializationFailure, log failedAt=commit (R1)', async () => {
    const a = new FaultInjectingDrizzleAdapter(
      {},
      { failAt: { commit: pgSerializationFailure() }, quiet: true },
    );
    const r = await mgr(a).withTransaction(async () => ok(42)); // work succeeds
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'SerializationFailure', sqlState: '40001' });
    expect(a.getBoundaryLog()).toEqual([
      { kind: 'new-root', outcome: 'rollback', failedAt: 'commit' },
    ]);
  });

  it('BEGIN fault → classified error, work never runs', async () => {
    const a = new FaultInjectingDrizzleAdapter(
      {},
      { failAt: { begin: pgAdminShutdown() }, quiet: true },
    );
    let ran = false;
    const r = await mgr(a).withTransaction(async () => {
      ran = true;
      return ok(1);
    });
    expect(ran).toBe(false);
    expect((r as { error: { kind: string } }).error.kind).toBe('ConnectionLost');
    expect(a.getBoundaryLog()).toEqual([
      { kind: 'new-root', outcome: 'rollback', failedAt: 'begin' },
    ]);
  });

  it('failOnce: fails first commit, succeeds on the second call', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { quiet: true }).failOnce(
      'commit',
      pgDeadlock(),
    );
    const r1 = await mgr(a).withTransaction(async () => ok('a'));
    const r2 = await mgr(a).withTransaction(async () => ok('b'));
    expect(r1.ok).toBe(false);
    expect(r2).toEqual({ ok: true, value: 'b' });
  });

  it('clear(phase) disarms an injection', async () => {
    const a = new FaultInjectingDrizzleAdapter(
      {},
      { failAt: { commit: pgDeadlock() }, quiet: true },
    );
    a.clear('commit');
    const r = await mgr(a).withTransaction(async () => ok('x'));
    expect(r).toEqual({ ok: true, value: 'x' });
  });
});

describe('FaultInjectingDrizzleAdapter — R2 shadowing + nested', () => {
  it('domain err + ROLLBACK fault → infra wins, domain E preserved in lostDomainError', async () => {
    const a = new FaultInjectingDrizzleAdapter(
      {},
      { failAt: { rollback: pgAdminShutdown() }, quiet: true },
    );
    const r = await mgr(a).withTransaction(async () => err({ kind: 'NotFound' } as const));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'ConnectionLost',
      sqlState: '57P01',
      lostDomainError: { kind: 'NotFound' },
    });
    expect(a.getBoundaryLog()).toEqual([
      { kind: 'new-root', outcome: 'rollback', failedAt: 'rollback' },
    ]);
  });

  it('domain err + successful rollback (no fault) → domain E returned faithfully, no lostDomainError', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { quiet: true });
    const r = await mgr(a).withTransaction(async () => err({ kind: 'SoldOut' } as const));
    expect(r).toEqual({ ok: false, error: { kind: 'SoldOut' } });
    expect(a.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'rollback' }]); // no failedAt
  });

  it('NESTED: ROLLBACK TO SAVEPOINT fault (socket) → ConnectionLost, undefined sqlState, E preserved', async () => {
    // Outer REQUIRED joins nothing yet; run an outer tx, then a NESTED child that errs while its
    // savepoint-rollback is faulted. The child boundary is the 'nested' entry.
    const a = new FaultInjectingDrizzleAdapter(
      {},
      { failAt: { 'rollback-to-savepoint': socketError() }, quiet: true },
    );
    const m = mgr(a);
    const r = await m.withTransaction(async () =>
      m.withTransaction(Propagation.Nested, async () => err({ kind: 'BadChild' } as const)),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'ConnectionLost',
      sqlState: undefined,
      lostDomainError: { kind: 'BadChild' },
    });
    // the nested boundary logged the savepoint-rollback fault:
    expect(
      a.getBoundaryLog().some((e) => e.kind === 'nested' && e.failedAt === 'rollback-to-savepoint'),
    ).toBe(true);
  });

  it('SAVEPOINT fault → nested work never runs', async () => {
    const a = new FaultInjectingDrizzleAdapter(
      {},
      { failAt: { savepoint: pgAdminShutdown() }, quiet: true },
    );
    const m = mgr(a);
    let childRan = false;
    await m.withTransaction(async () =>
      m.withTransaction(Propagation.Nested, async () => {
        childRan = true;
        return ok(1);
      }),
    );
    expect(childRan).toBe(false);
  });
});
