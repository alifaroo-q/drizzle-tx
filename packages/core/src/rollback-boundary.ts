import {
  connectionLost,
  type DrizzleTxError,
  deadlockDetected,
  poolConnectionTimeout,
  serializationFailure,
  transactionAborted,
} from './errors.js';
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

const SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED']);
const CONN_LOST_SQLSTATE = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
  '57P04',
  '57P05',
]);

const messageOf = (e: unknown): string =>
  typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
    ? (e as { message: string }).message
    : String(e);

/** Walk the `.cause` chain (bounded) so a wrapped driver error is still classified by the
 *  underlying pg/socket markers rather than the opaque wrapper. Drizzle rc.4 wraps every query —
 *  including COMMIT/ROLLBACK — in a `DrizzleQueryError` whose `.cause` is the real pg
 *  `DatabaseError`, so the SQLSTATE lives one frame down, not on the caught value. */
function* causeChain(e: unknown): Generator<object> {
  let cur = e;
  for (let depth = 0; depth < 8 && typeof cur === 'object' && cur !== null; depth++) {
    yield cur;
    cur = (cur as { cause?: unknown }).cause;
  }
}

/** A pg DatabaseError is recognised structurally: a 5-char string `.code` with a string
 *  `.severity`. Searched across the whole cause chain (drizzle wraps it). */
const sqlStateOf = (e: unknown): string | undefined => {
  for (const frame of causeChain(e)) {
    const { code, severity } = frame as { code?: unknown; severity?: unknown };
    if (typeof code === 'string' && code.length === 5 && typeof severity === 'string') return code;
  }
  return undefined;
};

/** Socket / code-less teardown — checked BEFORE SQLSTATE so a libuv EPIPE is never read as a
 *  SQLSTATE. Searched across the whole cause chain; the fuzzy "Connection terminated" message
 *  only counts when no SQLSTATE exists anywhere in the chain. */
const isSocketLoss = (e: unknown): boolean => {
  let sawConnTerminated = false;
  for (const frame of causeChain(e)) {
    const { syscall, code, severity, message } = frame as {
      syscall?: unknown;
      code?: unknown;
      severity?: unknown;
      message?: unknown;
    };
    if (typeof syscall === 'string') return true;
    if (typeof code === 'string' && SOCKET_CODES.has(code) && typeof severity !== 'string')
      return true;
    if (typeof message === 'string' && message.includes('Connection terminated'))
      sawConnTerminated = true;
  }
  return sawConnTerminated && sqlStateOf(e) === undefined;
};

/** Pure. Classify a non-RollbackSignal caught value into a structured DrizzleTxError (ADR-0012 §3). */
export function classifyCaught(e: unknown, lostDomainError?: unknown): DrizzleTxError {
  const base = {
    message: messageOf(e),
    cause: e,
    ...(lostDomainError !== undefined ? { lostDomainError } : {}),
  };
  if (isSocketLoss(e)) return connectionLost({ ...base, sqlState: undefined });
  const sqlState = sqlStateOf(e);
  if (sqlState === '40001') return serializationFailure({ ...base, sqlState });
  if (sqlState === '40P01') return deadlockDetected({ ...base, sqlState });
  if (sqlState !== undefined && CONN_LOST_SQLSTATE.has(sqlState))
    return connectionLost({ ...base, sqlState });
  return transactionAborted({ ...base, sqlState });
}

/** Classify a throw caught at the transaction boundary. `inFlight` (ADR-0012 §2) is the domain
 *  error recorded before the rollback signal was thrown — attached as `lostDomainError` only when
 *  the caught value is NOT the RollbackSignal (i.e. a failing ROLLBACK shadowed it). */
export function classifyRollback<E>(
  e: unknown,
  inFlight?: { error: E },
): Result<never, E | DrizzleTxError> {
  if (e instanceof RollbackSignal) return err(e.payload as E);
  if (isPoolTimeoutError(e)) return err(poolConnectionTimeout(e.timeoutMs));
  return err(classifyCaught(e, inFlight?.error));
}
