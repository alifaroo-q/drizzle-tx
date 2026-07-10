import type { TxOptions } from '../options.js';

export interface TransactionAdapter<TClient> {
  /** The pool-backed base client (used outside a transaction and to start new top-level ones). */
  getBaseClient(): TClient;

  /** True if the adapter can start an independent concurrent top-level transaction
   *  (i.e. Pool-backed). REQUIRES_NEW while already active requires this. */
  readonly supportsIndependentTransactions: boolean;

  /** Start a new top-level transaction from the base client; the tx client is passed to `work`. */
  wrapWithTransaction<T>(
    options: TxOptions | undefined,
    work: (tx: TClient) => Promise<T>,
  ): Promise<T>;

  /** Start a savepoint from the given parent transaction client; the savepoint client is passed to `work`. */
  wrapWithNestedTransaction<T>(parent: TClient, work: (sp: TClient) => Promise<T>): Promise<T>;
}
