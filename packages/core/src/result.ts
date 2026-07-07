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

// --- Combinators ---------------------------------------------------------------
// Standalone functions (not methods) so consumers depend only on the `Result` TYPE,
// never on this runtime, and so the helpers stay tree-shakable.

/** Transform the success value; an `err` passes through unchanged. */
export const map = <T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> =>
  result.ok ? ok(f(result.value)) : result;

/** Transform the error; an `ok` passes through unchanged. */
export const mapErr = <T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> =>
  result.ok ? result : err(f(result.error));

/** Chain a fallible step onto a success; the error channels union. */
export const andThen = <T, U, E, F>(
  result: Result<T, E>,
  f: (value: T) => Result<U, F>,
): Result<U, E | F> => (result.ok ? f(result.value) : result);

/** Unwrap the success value, or return `fallback` on `err`.
 *  `fallback` is `NoInfer<T>` so it is checked against `T` without widening it. */
export const unwrapOr = <T, E>(result: Result<T, E>, fallback: NoInfer<T>): T =>
  result.ok ? result.value : fallback;

/** Fold both channels to a single value. */
export const match = <T, E, R>(
  result: Result<T, E>,
  handlers: { readonly ok: (value: T) => R; readonly err: (error: E) => R },
): R => (result.ok ? handlers.ok(result.value) : handlers.err(result.error));
