export type {
  DrizzleTxError,
  DrizzleTxErrorKind,
  Independent,
  Result,
  TransactionScope,
  TransactionWork,
  TxOptions,
} from '@drizzle-tx/core';
// Re-export the Result/propagation surface so consumers import from one place.
export {
  andThen,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  match,
  matchError,
  ok,
  Propagation,
  settle,
  unwrapOr,
} from '@drizzle-tx/core';
export type {
  DrizzleTransactionModuleAsyncOptions,
  DrizzleTransactionModuleOptions,
} from './drizzle-transaction.module.js';
export { DrizzleTransactionModule } from './drizzle-transaction.module.js';
export { InjectTransactionalClient } from './inject.js';
export { DRIZZLE_BASE_DB, DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER } from './tokens.js';
export { TransactionHost } from './transaction-host.js';
export { Transactional } from './transactional.decorator.js';
