import { type DrizzleTxError, matchError } from './errors.js';
import { assertNever } from './result.js';

// If a variant is added without a case here, this fails to compile — proving exhaustiveness.
export function describeError(e: DrizzleTxError): string {
  switch (e.kind) {
    case 'PoolConnectionTimeout':
      return `pool timeout after ${e.timeoutMs}ms`;
    case 'TransactionAborted':
      return 'aborted';
    case 'HostNotInitialized':
      return `host not initialized for ${e.connectionName ?? 'default'}`;
    case 'NotPoolBacked':
      return 'base db is not Pool-backed';
    default:
      return assertNever(e);
  }
}

// matchError is exhaustive: a complete handler map compiles.
export const matchOk = (e: DrizzleTxError): string =>
  matchError(e, {
    PoolConnectionTimeout: () => 'timeout',
    TransactionAborted: () => 'aborted',
    HostNotInitialized: () => 'host',
    NotPoolBacked: () => 'not-pool',
  });

// Omitting a variant (here NotPoolBacked) MUST be a compile error.
export const matchBad = (e: DrizzleTxError): string =>
  // @ts-expect-error — handler map must cover every DrizzleTxError kind
  matchError(e, {
    PoolConnectionTimeout: () => 'timeout',
    TransactionAborted: () => 'aborted',
    HostNotInitialized: () => 'host',
  });
