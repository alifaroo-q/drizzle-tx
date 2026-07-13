import { Pool } from 'pg';
import type { TxOptions } from '../options.js';
import type { TransactionAdapter } from './port.js';

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

/** True when `$client` is a pg `Pool` (required for REQUIRES_NEW — ADR-0002).
 *  `instanceof Pool` is the primary check, but it is identity-sensitive: a duplicated
 *  `pg` module instance (ESM/CJS interop, or a monorepo test harness loading the built
 *  package alongside source) yields a different `Pool` class and a false negative. The
 *  structural fallback recognises a pg Pool by its pool-only counters (`totalCount` /
 *  `idleCount`), which a single `pg.Client` does not expose. */
function isPoolBacked(client: unknown): boolean {
  if (client instanceof Pool) return true;
  return (
    typeof client === 'object' &&
    client !== null &&
    'totalCount' in client &&
    'idleCount' in client &&
    typeof (client as { connect?: unknown }).connect === 'function'
  );
}

/** The configured pg pool connect timeout, read structurally (no pg import). `0`/absent means
 *  "wait forever" (pg default) → no finite timeout to report. */
function poolConnectTimeoutMs(client: unknown): number | undefined {
  const ms = (client as { options?: { connectionTimeoutMillis?: unknown } })?.options
    ?.connectionTimeoutMillis;
  return typeof ms === 'number' && ms > 0 ? ms : undefined;
}

export class DrizzleAdapter<TClient extends DrizzleTxCapable>
  implements TransactionAdapter<TClient>
{
  readonly #db: TClient;
  readonly #connectTimeoutMs: number | undefined;
  readonly supportsIndependentTransactions: boolean;

  constructor(config: DrizzleAdapterConfig<TClient>) {
    this.#db = config.db;
    this.#connectTimeoutMs = poolConnectTimeoutMs(config.db.$client);
    this.supportsIndependentTransactions = isPoolBacked(config.db.$client);
  }

  getBaseClient(): TClient {
    return this.#db;
  }

  wrapWithTransaction<T>(
    options: TxOptions | undefined,
    work: (tx: TClient) => Promise<T>,
  ): Promise<T> {
    return this.#db
      .transaction(async (tx) => work(tx), options)
      .catch((e: unknown) => {
        if (e instanceof Error && /timeout exceeded when trying to connect/i.test(e.message)) {
          throw new PoolTimeoutError(this.#connectTimeoutMs);
        }
        throw e;
      });
  }

  wrapWithNestedTransaction<T>(parent: TClient, work: (sp: TClient) => Promise<T>): Promise<T> {
    // Nested == SAVEPOINT; no options (isolation is fixed at the outer tx).
    return parent.transaction(async (sp) => work(sp));
  }
}
