export {
  DrizzleAdapter,
  type DrizzleAdapterConfig,
  type DrizzleTxCapable,
} from './adapters/drizzle.js';
export * from './adapters/port.js';
export {
  type CreateDrizzleTxOptions,
  createDrizzleTx,
  type DrizzleTx,
} from './create-drizzle-tx.js';
export { UnsupportedDriverError } from './driver-capability.js';
export * from './errors.js';
export * from './logger.js';
export * from './options.js';
export * from './propagation.js';
export * from './result.js';

import type { TransactionManager as _TM } from './transaction-manager.js';
/** @remarks Adapter-author API. The `withTransaction` overload contract (incl. the REQUIRES_NEW
 *  `Independent` brand) — reference this instead of re-declaring the overloads when wrapping the manager. */
export type WithTransaction<TClient> = _TM<TClient>['withTransaction'];
export {
  TransactionManager,
  type TransactionManagerOptions,
  type TransactionWork,
} from './transaction-manager.js';
export type { TransactionScope } from './transaction-scope.js';
export { createTransactionalClient } from './transactional-client.js';
