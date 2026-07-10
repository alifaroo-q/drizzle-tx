import { TransactionManager } from '@drizzle-tx/core';
import { NoOpDrizzleAdapter, type NoOpBoundaryLogEntry } from '@drizzle-tx/core/testing';

/** The testing surface attached to a no-op transaction-manager override. */
export type NoOpTransactionManager<TClient> = TransactionManager<TClient> & {
  /** The adapter's live boundary log. */
  getBoundaryLog(): readonly NoOpBoundaryLogEntry[];
  /** Clears the boundary log between test cases. */
  resetBoundaryLog(): void;
};

/**
 * Creates the value to pass to Nest's `overrideProvider(DRIZZLE_TX_MANAGER)`.
 *
 * The returned manager is a real TransactionManager, so the normal transactional
 * decorator, TransactionHost, and DRIZZLE_TX_CLIENT graph remain under test.
 */
export function createNoOpTransactionManager<TClient>(client: TClient): NoOpTransactionManager<TClient> {
  const adapter = new NoOpDrizzleAdapter(client, { quiet: true });
  const manager = new TransactionManager(adapter) as NoOpTransactionManager<TClient>;
  manager.getBoundaryLog = () => adapter.getBoundaryLog();
  manager.resetBoundaryLog = () => adapter.resetBoundaryLog();
  return manager;
}
