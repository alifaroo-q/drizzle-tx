export type DrizzleTxError =
  | { readonly kind: 'PoolConnectionTimeout'; readonly timeoutMs: number | undefined }
  | { readonly kind: 'TransactionAborted'; readonly cause: unknown }
  | { readonly kind: 'HostNotInitialized'; readonly connectionName: string | undefined }
  | { readonly kind: 'NotPoolBacked' };

export const poolConnectionTimeout = (timeoutMs: number | undefined): DrizzleTxError => ({
  kind: 'PoolConnectionTimeout',
  timeoutMs,
});
export const transactionAborted = (cause: unknown): DrizzleTxError => ({
  kind: 'TransactionAborted',
  cause,
});
export const hostNotInitialized = (connectionName: string | undefined): DrizzleTxError => ({
  kind: 'HostNotInitialized',
  connectionName,
});
export const notPoolBacked = (): DrizzleTxError => ({ kind: 'NotPoolBacked' });
