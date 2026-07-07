import { Pool } from 'pg';
import type { TransactionAdapter } from './adapter.js';
import type { TxOptions } from './options.js';

/** Marker thrown when a pg pool connection acquisition times out (ADR-0002 fail-fast).
 *  The manager maps it to `DrizzleTxError.PoolConnectionTimeout` by constructor name,
 *  avoiding a core→pg import cycle. */
export class PoolTimeoutError {
  // Explicit field (not a parameter property) to satisfy `erasableSyntaxOnly`.
  readonly timeoutMs: number | undefined;
  constructor(timeoutMs: number | undefined) {
    this.timeoutMs = timeoutMs;
  }
}

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
    return this.#db
      .transaction(async (tx) => {
        setClient(tx);
        return work();
      }, options)
      .catch((e: unknown) => {
        if (e instanceof Error && /timeout exceeded when trying to connect/i.test(e.message)) {
          throw new PoolTimeoutError(undefined);
        }
        throw e;
      });
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
