import { type DrizzleTxError, poolConnectionTimeout, transactionAborted } from './errors.js';
import { err, type Result } from './result.js';

/** Internal throw used ONLY to carry a consumer error E through Drizzle's throw-to-rollback
 *  path; caught and re-materialized as a Result at the same boundary. */
export class RollbackSignal<E> {
  // Explicit field (not a parameter property) to satisfy `erasableSyntaxOnly`.
  readonly payload: E;
  constructor(payload: E) {
    this.payload = payload;
  }
}

/** Structural shape of the adapter's PoolTimeoutError. Kept here (not imported from the
 *  pg-backed adapter) so core never pulls `pg` into its module graph. */
interface PoolTimeoutLike {
  readonly timeoutMs: number | undefined;
}

/** Recognise the adapter's PoolTimeoutError by constructor name rather than instanceof. */
export function isPoolTimeoutError(e: unknown): e is PoolTimeoutLike {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { constructor?: { name?: string } }).constructor?.name === 'PoolTimeoutError'
  );
}

/** ok → the value; err → throw the rollback signal (the one place no-throw is inverted). */
export function toThrowable<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new RollbackSignal(result.error);
  return result.value;
}

/** Pure. Classify a throw caught at the transaction boundary into a Result error. */
export function classifyRollback<E>(e: unknown): Result<never, E | DrizzleTxError> {
  if (e instanceof RollbackSignal) return err(e.payload as E);
  if (isPoolTimeoutError(e)) return err(poolConnectionTimeout(e.timeoutMs));
  return err(transactionAborted(e));
}
