import { describe, expect, it } from 'vitest';
import { classifyCaught } from '../../src/rollback-boundary.js';
import {
  fakePgError, socketError, pgSerializationFailure, pgDeadlock, pgAdminShutdown,
} from '../../src/adapters/fault-injecting.js';

describe('fault-injecting error helpers', () => {
  it('fakePgError carries a 5-char code + string severity (classifies structurally)', () => {
    const e = fakePgError('23505', 'dup key');
    expect(e).toMatchObject({ code: '23505', message: 'dup key', severity: expect.any(String) });
    // structural markers present → classifyCaught reads the SQLSTATE:
    expect(classifyCaught(e)).toMatchObject({ kind: 'TransactionAborted', sqlState: '23505' });
  });

  it('pgSerializationFailure → SerializationFailure(40001)', () => {
    expect(classifyCaught(pgSerializationFailure())).toMatchObject({ kind: 'SerializationFailure', sqlState: '40001' });
  });

  it('pgDeadlock → DeadlockDetected(40P01)', () => {
    expect(classifyCaught(pgDeadlock())).toMatchObject({ kind: 'DeadlockDetected', sqlState: '40P01' });
  });

  it('pgAdminShutdown → ConnectionLost(57P01)', () => {
    expect(classifyCaught(pgAdminShutdown())).toMatchObject({ kind: 'ConnectionLost', sqlState: '57P01' });
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
