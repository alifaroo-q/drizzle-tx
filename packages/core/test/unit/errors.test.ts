import { describe, expect, it } from 'vitest';
import {
  type DrizzleTxError,
  hostNotInitialized,
  matchError,
  notPoolBacked,
  poolConnectionTimeout,
} from '../../src/errors.js';

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
