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

declare const IND: unique symbol;

/** A REQUIRES_NEW outcome that already settled on its OWN connection. Inspect it directly
 *  (`.ok`/`.value`/`.error`); it CANNOT be `return`ed as an outer Result by accident —
 *  `settle()` it consciously to propagate its outcome to the outer transaction. Zero runtime cost. */
export type Independent<T, E> = Result<T, E> & { readonly [IND]: true };

/** The transactional-work return poison: a Result that must NOT be a branded `Independent`
 *  (`true ⊄ never`). A plain Result satisfies it (the optional phantom is absent); an
 *  `Independent` does not — so `return inner` for a REQUIRES_NEW outcome fails to compile. */
export type NonIndependent<T, E> = Result<T, E> & { readonly [IND]?: never };

/** Unwrap an `Independent` to a plain `Result` (runtime: identity, ZERO cost). Returning this at
 *  the outer boundary is the conscious opt-in that "inner err → outer rollback". The return-type
 *  annotation alone strips the brand — `Independent<T,E>` already IS a `Result<T,E>`, no cast. */
export const settle = <T, E>(i: Independent<T, E>): Result<T, E> => i;

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
