export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

// Return `Result<T, never>` / `Result<never, E>` (not `Ok<T>` / `Err<E>`): the `never`
// on the unused side is load-bearing. It lets a work function that only returns `ok(...)`
// still infer its error channel as `never` (so `E | DrizzleTxError` collapses to
// `DrizzleTxError`) instead of widening it to `unknown`.
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export function assertNever(x: never, message = 'Unhandled variant'): never {
  throw new Error(`${message}: ${JSON.stringify(x)}`);
}
