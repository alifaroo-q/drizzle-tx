import { describe, expect, it } from 'vitest';
import {
  connectionLost,
  type DrizzleTxError,
  deadlockDetected,
  hostNotInitialized,
  matchError,
  notPoolBacked,
  poolConnectionTimeout,
  serializationFailure,
  transactionAborted,
} from '../../src/errors.js';

describe('transaction-body error constructors', () => {
  it('serializationFailure carries the triad + kind', () => {
    const cause = new Error('40001');
    expect(serializationFailure({ message: 'conflict', sqlState: '40001', cause })).toEqual({
      kind: 'SerializationFailure',
      message: 'conflict',
      sqlState: '40001',
      cause,
    });
  });

  it('deadlockDetected carries kind DeadlockDetected', () => {
    expect(
      deadlockDetected({ message: 'deadlock', sqlState: '40P01', cause: undefined }).kind,
    ).toBe('DeadlockDetected');
  });

  it('connectionLost allows undefined sqlState (socket loss)', () => {
    const e = connectionLost({
      message: 'Connection terminated unexpectedly',
      sqlState: undefined,
      cause: new Error(),
    });
    expect(e).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
  });

  it('transactionAborted now takes TxFailureFields and can carry lostDomainError', () => {
    const domain = { kind: 'SoldOut' };
    const e = transactionAborted({
      message: 'rollback failed',
      sqlState: undefined,
      cause: new Error('x'),
      lostDomainError: domain,
    });
    expect(e).toMatchObject({
      kind: 'TransactionAborted',
      message: 'rollback failed',
      lostDomainError: domain,
    });
  });
});

describe('matchError', () => {
  const describe_ = (e: DrizzleTxError): string =>
    matchError(e, {
      PoolConnectionTimeout: (x) => `timeout:${x.timeoutMs}`,
      TransactionAborted: () => 'aborted',
      HostNotInitialized: (x) => `host:${x.connectionName ?? 'default'}`,
      NotPoolBacked: () => 'not-pool',
    });

  it('dispatches to the handler for the matching kind, narrowed', () => {
    expect(describe_(poolConnectionTimeout(3000))).toBe('timeout:3000');
    expect(describe_(hostNotInitialized(undefined))).toBe('host:default');
    expect(describe_(notPoolBacked())).toBe('not-pool');
  });
});
