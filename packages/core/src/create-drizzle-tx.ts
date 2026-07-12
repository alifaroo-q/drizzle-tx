import { DrizzleAdapter, type DrizzleTxCapable } from './adapters/drizzle.js';
import { rejectUnsupportedDriver } from './driver-capability.js';
import { TransactionManager, type TransactionManagerOptions } from './transaction-manager.js';
import { createTransactionalClient } from './transactional-client.js';

export interface CreateDrizzleTxOptions<TClient extends DrizzleTxCapable>
  extends TransactionManagerOptions {
  /** The base client: a Drizzle instance (node-postgres / neon-serverless / postgres-js …). */
  readonly drizzle: TClient;
}

/** The single canonical assembly result. Types for `withTransaction` / `begin` / `isActive`
 *  are indexed off `TransactionManager` so the 4 `withTransaction` overloads and the
 *  `Result<T, E | DrizzleTxError>` union are preserved through the factory (ADR-0010). */
export interface DrizzleTx<TClient extends DrizzleTxCapable> {
  /** The transactional client (auto-joins the active tx; else the base client). Import in repositories. */
  readonly db: TClient;
  readonly manager: TransactionManager<TClient>;
  readonly withTransaction: TransactionManager<TClient>['withTransaction'];
  readonly begin: TransactionManager<TClient>['begin'];
  readonly isActive: TransactionManager<TClient>['isTransactionActive'];
}

/** The single non-DI assembly path — every surface (NestJS, tRPC, Next) builds on this so
 *  defaults can't drift. Throws `UnsupportedDriverError` at construction if `drizzle` is a
 *  driver that cannot host interactive transactions (Neon HTTP). See the driver matrix in
 *  the package README and ADR-0009 / ADR-0010.
 *
 *  | Driver | Interactive tx |
 *  |---|---|
 *  | node-postgres `pg.Pool` | ✅ full |
 *  | neon-serverless (WebSocket Pool) | ✅ full |
 *  | neon-http | ❌ hard-unsupported — throws here |
 *  | PgBouncer / Supavisor txn mode | ⚠️ `REQUIRED` ok (`prepare:false`); `REQUIRES_NEW` doubles backend pressure |
 */
export function createDrizzleTx<TClient extends DrizzleTxCapable>(
  options: CreateDrizzleTxOptions<TClient>,
): DrizzleTx<TClient> {
  const { drizzle, ...managerOptions } = options;
  rejectUnsupportedDriver(drizzle);
  const manager = new TransactionManager<TClient>(
    new DrizzleAdapter({ db: drizzle }),
    managerOptions,
  );
  const db = createTransactionalClient<TClient>(() => manager.getTransactionClient());
  return {
    db,
    manager,
    // Runtime `.bind` preserves `this`; the interface's indexed-access types restore the
    // overloaded/generic signatures that `.bind` erases at the type level.
    withTransaction: manager.withTransaction.bind(manager) as DrizzleTx<TClient>['withTransaction'],
    begin: manager.begin.bind(manager),
    isActive: manager.isTransactionActive.bind(manager),
  };
}
