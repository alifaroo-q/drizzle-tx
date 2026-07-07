import { Pool } from 'pg';
import type { TransactionAdapter } from './adapter.js';
import type { TxOptions } from './options.js';

/** Minimal structural type for a Drizzle client that can open transactions.
 *  Avoids a hard dependency on drizzle-orm's concrete types. */
export interface DrizzleTxCapable {
  transaction: <T>(fn: (tx: this) => Promise<T>, config?: TxOptions) => Promise<T>;
  $client?: unknown;
}

export interface DrizzleAdapterConfig<TClient extends DrizzleTxCapable> {
  readonly db: TClient;
}

export class DrizzleAdapter<TClient extends DrizzleTxCapable>
  implements TransactionAdapter<TClient>
{
  readonly #db: TClient;
  readonly supportsIndependentTransactions: boolean;

  constructor(config: DrizzleAdapterConfig<TClient>) {
    this.#db = config.db;
    this.supportsIndependentTransactions = config.db.$client instanceof Pool;
  }

  getBaseClient(): TClient {
    return this.#db;
  }

  wrapWithTransaction<T>(
    options: TxOptions | undefined,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.#db.transaction(async (tx) => {
      setClient(tx);
      return work();
    }, options);
  }

  wrapWithNestedTransaction<T>(
    parent: TClient,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T> {
    // Nested == SAVEPOINT; no options (isolation is fixed at the outer tx).
    return parent.transaction(async (sp) => {
      setClient(sp);
      return work();
    });
  }
}
