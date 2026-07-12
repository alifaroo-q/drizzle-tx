import { describe, expect, it } from 'vitest';
import {
  FaultInjectingDrizzleAdapter,
  fakePgError,
  socketError,
} from '../../src/adapters/fault-injecting.js';
import { err, ok } from '../../src/result.js';
import { TransactionManager } from '../../src/transaction-manager.js';

const run = (failAt: Record<string, unknown>, work: () => Promise<any>) =>
  new TransactionManager<{}>(
    new FaultInjectingDrizzleAdapter({}, { failAt: failAt as any, quiet: true }),
    { logger: { warn() {} } },
  ).withTransaction(work);

describe('T2: failure-scenario classification matrix', () => {
  // Each SQLSTATE surfaces as its variant regardless of whether it fires at COMMIT or ROLLBACK.
  it.each([
    ['40001', 'SerializationFailure'],
    ['40P01', 'DeadlockDetected'],
    ['08006', 'ConnectionLost'],
    ['57P03', 'ConnectionLost'],
    ['23505', 'TransactionAborted'], // unique_violation — residual, but sqlState carried
  ])('COMMIT fails with %s → %s (sqlState carried)', async (code, kind) => {
    const r = await run({ commit: fakePgError(code) }, async () => ok('work-ok'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind, sqlState: code });
  });

  it('R1: ok-returning work still errs when COMMIT fails', async () => {
    const r = await run({ commit: fakePgError('40001') }, async () => ok(123));
    expect(r.ok).toBe(false); // documented contract (ADR-0012 R1)
  });

  it('R2: domain err + ROLLBACK double-fault → infra wins, lostDomainError preserved', async () => {
    const r = await run({ rollback: fakePgError('57P01') }, async () => err({ kind: 'DomainX' } as const));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      kind: 'ConnectionLost',
      sqlState: '57P01',
      lostDomainError: { kind: 'DomainX' },
    });
  });

  it('conn-loss: code-less socket teardown at commit → ConnectionLost, undefined sqlState', async () => {
    const r = await run({ commit: socketError() }, async () => ok('x'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
  });

  it('clean commit path is unaffected by an unrelated armed phase', async () => {
    // a rollback fault must NOT fire when work commits cleanly
    const r = await run({ rollback: fakePgError('40001') }, async () => ok('committed'));
    expect(r).toEqual({ ok: true, value: 'committed' });
  });
});
