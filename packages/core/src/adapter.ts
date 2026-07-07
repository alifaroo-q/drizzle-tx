import type { TxOptions } from './options.js';

export interface TransactionAdapter<TClient> {
  /** The pool-backed base client (used outside a transaction and to start new top-level ones). */
  getBaseClient(): TClient;

  /** True if the adapter can start an independent concurrent top-level transaction
   *  (i.e. Pool-backed). REQUIRES_NEW while already active requires this. */
  readonly supportsIndependentTransactions: boolean;

  /** Start a new top-level transaction from the base client; call setClient with the tx client. */
  wrapWithTransaction<T>(
    options: TxOptions | undefined,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T>;

  /** Start a savepoint from the given parent transaction client. */
  wrapWithNestedTransaction<T>(
    parent: TClient,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T>;
}
