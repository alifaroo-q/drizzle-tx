import { describe, expect, it } from 'vitest';
import { err, ok } from './result.js';
import { classifyRollback, RollbackSignal, toThrowable } from './rollback-boundary.js';

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
    expect(classifyRollback(boom)).toEqual({
      ok: false,
      error: { kind: 'TransactionAborted', cause: boom },
    });
  });
});
