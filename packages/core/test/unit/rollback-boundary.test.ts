import { describe, expect, it } from 'vitest';
import { err, ok } from '../../src/result.js';
import { classifyRollback, RollbackSignal, toThrowable } from '../../src/rollback-boundary.js';

describe('toThrowable', () => {
  it('returns the value for ok', () => {
    expect(toThrowable(ok(42))).toBe(42);
  });

  it('throws a RollbackSignal carrying the error for err', () => {
    try {
      toThrowable(err('DOMAIN_FAIL' as const));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RollbackSignal);
      expect((e as RollbackSignal<string>).payload).toBe('DOMAIN_FAIL');
    }
  });
});

describe('classifyRollback', () => {
  it('unwraps a RollbackSignal back into err(payload)', () => {
    expect(classifyRollback(new RollbackSignal('DOMAIN_FAIL'))).toEqual({
      ok: false,
      error: 'DOMAIN_FAIL',
    });
  });

  it('maps a PoolTimeoutError (by constructor name) to PoolConnectionTimeout', () => {
    class PoolTimeoutError {
      readonly timeoutMs = 250;
    }
    expect(classifyRollback(new PoolTimeoutError())).toEqual({
      ok: false,
      error: { kind: 'PoolConnectionTimeout', timeoutMs: 250 },
    });
  });

  it('maps an arbitrary throw to TransactionAborted preserving the cause', () => {
    const boom = new Error('kaboom');
    expect(classifyRollback(boom)).toMatchObject({
      ok: false,
      error: { kind: 'TransactionAborted', cause: boom },
    });
  });
});

describe('classifyRollback — structural SQLSTATE classification (ADR-0012 §3)', () => {
  // helper: a fake pg DatabaseError — 5-char .code + string .severity (structural marker)
  const dbErr = (code: string, message = 'db error') =>
    Object.assign(new Error(message), { code, severity: 'ERROR', routine: 'exec_simple_query' });
  // helper: a libuv socket error
  const sockErr = (code: string) => Object.assign(new Error(code), { code, syscall: 'read' });

  it('40001 → SerializationFailure with sqlState', () => {
    const r = classifyRollback(dbErr('40001', 'could not serialize'));
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'SerializationFailure', sqlState: '40001', message: 'could not serialize' },
    });
  });

  it('40P01 → DeadlockDetected', () => {
    expect((classifyRollback(dbErr('40P01')) as { error: { kind: string } }).error.kind).toBe(
      'DeadlockDetected',
    );
  });

  it.each([
    '08000',
    '08006',
    '08P01',
    '57P01',
    '57P03',
  ])('%s → ConnectionLost with sqlState', (code) => {
    expect(
      (classifyRollback(dbErr(code)) as { error: { kind: string; sqlState: string } }).error,
    ).toMatchObject({ kind: 'ConnectionLost', sqlState: code });
  });

  it.each([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
  ])('libuv %s → ConnectionLost with UNDEFINED sqlState (socket checked first)', (code) => {
    expect(
      (classifyRollback(sockErr(code)) as { error: { kind: string; sqlState: undefined } }).error,
    ).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
  });

  it('code-less "Connection terminated unexpectedly" → ConnectionLost, undefined sqlState', () => {
    expect(
      (
        classifyRollback(new Error('Connection terminated unexpectedly')) as {
          error: { kind: string };
        }
      ).error.kind,
    ).toBe('ConnectionLost');
  });

  it('57014 query_canceled → TransactionAborted but KEEPS sqlState', () => {
    expect(
      (classifyRollback(dbErr('57014')) as { error: { kind: string; sqlState: string } }).error,
    ).toMatchObject({ kind: 'TransactionAborted', sqlState: '57014' });
  });

  it('plain user throw → TransactionAborted, undefined sqlState, message preserved', () => {
    expect(
      (
        classifyRollback(new Error('boom')) as {
          error: { kind: string; sqlState: undefined; message: string };
        }
      ).error,
    ).toMatchObject({ kind: 'TransactionAborted', sqlState: undefined, message: 'boom' });
  });

  it('non-Error throw (string) → TransactionAborted with a default message', () => {
    const r = classifyRollback('weird') as {
      error: { kind: string; message: string; cause: unknown };
    };
    expect(r.error.kind).toBe('TransactionAborted');
    expect(typeof r.error.message).toBe('string');
    expect(r.error.cause).toBe('weird');
  });

  it('RollbackSignal → err(payload) unchanged (domain error faithful)', () => {
    expect(classifyRollback(new RollbackSignal({ kind: 'SoldOut' }))).toEqual({
      ok: false,
      error: { kind: 'SoldOut' },
    });
  });

  it('wrapped DrizzleQueryError → classified by the nested pg DatabaseError (cause chain)', () => {
    // Drizzle wraps a COMMIT/query failure; the pg fields live one .cause down, not on top.
    const pgErr = dbErr('40001', 'could not serialize access');
    const wrapped = Object.assign(new Error('Failed query: commit'), {
      name: 'DrizzleQueryError',
      cause: pgErr,
    });
    expect(
      (classifyRollback(wrapped) as { error: { kind: string; sqlState: string } }).error,
    ).toMatchObject({ kind: 'SerializationFailure', sqlState: '40001' });
  });
});
