import type { DrizzleTxError } from './errors.js';
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
