// ─── Tier A: app-developer API ────────────────────────────────────────────────

export type { DrizzleAdapterConfig, DrizzleTxCapable } from './adapters/drizzle.js';
export {
  type CreateDrizzleTxOptions,
  createDrizzleTx,
  type DrizzleTx,
} from './create-drizzle-tx.js';
export { UnsupportedDriverError } from './driver-capability.js';
export {
  type DrizzleTxError,
  type DrizzleTxErrorHandlers,
  type DrizzleTxErrorKind,
  matchError,
} from './errors.js';
export { consoleLogger, noopLogger, type TxLogger } from './logger.js';
// (TxFailureFields is exported in Tier B — it's the factories' parameter type.)
export type { AccessMode, BeginOptions, IsolationLevel, TxOptions } from './options.js';
export { Propagation } from './propagation.js';
export {
  andThen,
  type Err,
  err,
  type Independent,
  isErr,
  isOk,
  map,
  mapErr,
  match,
  type Ok,
  ok,
  type Result,
  settle,
  unwrapOr,
} from './result.js';
export type { TransactionWork } from './transaction-manager.js';
export type { TransactionScope } from './transaction-scope.js';

// ─── Tier B: adapter-author API ───────────────────────────────────────────────
// This mid-file `import` intentionally separates the two export-sort groups so Biome keeps the
// Tier A / Tier B split (a contiguous run of `export … from` statements would be merged + sorted).
import type { WithTransaction as _WithTransaction } from './transaction-manager.js';
/** @remarks Adapter-author API. The withTransaction overload contract (incl. REQUIRES_NEW brand).
 *  Re-aliased from the canonical definition in transaction-manager.ts (single source of truth). */
export type WithTransaction<TClient> = _WithTransaction<TClient>;
export { DrizzleAdapter } from './adapters/drizzle.js';
export type { TransactionAdapter } from './adapters/port.js';
export {
  connectionLost,
  deadlockDetected,
  hostNotInitialized,
  notPoolBacked,
  poolConnectionTimeout,
  serializationFailure,
  type TxFailureFields,
  transactionAborted,
} from './errors.js';
export { TransactionManager, type TransactionManagerOptions } from './transaction-manager.js';
export { createTransactionalClient } from './transactional-client.js';

// NOT exported (internal): assertNever (result.ts) — use matchError for DrizzleTxError exhaustiveness.
// NOT exported (internal): NonIndependent (result.ts) — a work-return implementation detail, referenced
//   structurally by TransactionWork; not something consumers name.
