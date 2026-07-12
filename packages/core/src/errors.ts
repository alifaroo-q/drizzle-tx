/** Structured fields carried by every transaction-body failure (ADR-0012 §1). */
export interface TxFailureFields {
  readonly message: string;
  readonly sqlState: string | undefined;
  readonly cause: unknown;
  /** R2: the swallowed domain error when a rollback double-fault ate it. Distinct from `cause`. */
  readonly lostDomainError?: unknown;
}

export type DrizzleTxError =
  // assembly / pool — no structured triad:
  | { readonly kind: 'PoolConnectionTimeout'; readonly timeoutMs: number | undefined }
  | { readonly kind: 'HostNotInitialized'; readonly connectionName: string | undefined }
  | { readonly kind: 'NotPoolBacked' }
  // transaction-body failures — all carry TxFailureFields:
  | ({ readonly kind: 'SerializationFailure' } & TxFailureFields)
  | ({ readonly kind: 'DeadlockDetected' } & TxFailureFields)
  | ({ readonly kind: 'ConnectionLost' } & TxFailureFields)
  | ({ readonly kind: 'TransactionAborted' } & TxFailureFields);

export const poolConnectionTimeout = (timeoutMs: number | undefined): DrizzleTxError => ({
  kind: 'PoolConnectionTimeout',
  timeoutMs,
});
export const serializationFailure = (f: TxFailureFields): DrizzleTxError => ({
  kind: 'SerializationFailure',
  ...f,
});
export const deadlockDetected = (f: TxFailureFields): DrizzleTxError => ({
  kind: 'DeadlockDetected',
  ...f,
});
export const connectionLost = (f: TxFailureFields): DrizzleTxError => ({
  kind: 'ConnectionLost',
  ...f,
});
export const transactionAborted = (f: TxFailureFields): DrizzleTxError => ({
  kind: 'TransactionAborted',
  ...f,
});
export const hostNotInitialized = (connectionName: string | undefined): DrizzleTxError => ({
  kind: 'HostNotInitialized',
  connectionName,
});
export const notPoolBacked = (): DrizzleTxError => ({ kind: 'NotPoolBacked' });

/** The discriminant union of every `DrizzleTxError` variant — single source of truth,
 *  so a hand-written kind list can't drift from the union. */
export type DrizzleTxErrorKind = DrizzleTxError['kind'];

/** A handler per error kind, each receiving the narrowed variant. */
export type DrizzleTxErrorHandlers<R> = {
  readonly [K in DrizzleTxErrorKind]: (error: Extract<DrizzleTxError, { kind: K }>) => R;
};

/** Exhaustively match a `DrizzleTxError` by kind. Because the handler map is keyed by
 *  `DrizzleTxErrorKind`, omitting a variant is a compile error — the same guarantee as a
 *  `switch` + `assertNever`, in expression form (handy for `err` → `HttpException` mapping). */
export function matchError<R>(error: DrizzleTxError, handlers: DrizzleTxErrorHandlers<R>): R {
  // Correlated-union indexing isn't provable to the checker; the handler map's type
  // guarantees the handler accepts this exact variant, so the cast is sound.
  const handler = handlers[error.kind] as (error: DrizzleTxError) => R;
  return handler(error);
}
