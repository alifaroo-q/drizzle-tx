import type {
  BeginOptions,
  DrizzleTxError,
  Result,
  TransactionManager,
  TransactionScope,
  WithTransaction,
} from '@drizzle-tx/core';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_TX_MANAGER } from './tokens.js';

const registry = new Map<string, TransactionHost>();
const DEFAULT_KEY = 'default';

@Injectable()
export class TransactionHost {
  readonly #manager: TransactionManager<unknown>;
  /** Forwards to the manager, preserving all six overloads (incl. the REQUIRES_NEW brand). */
  readonly withTransaction: WithTransaction<unknown>;

  constructor(@Inject(DRIZZLE_TX_MANAGER) manager: TransactionManager<unknown>) {
    this.#manager = manager;
    this.withTransaction = manager.withTransaction.bind(manager);
    registry.set(DEFAULT_KEY, this);
  }

  // v1 wires a single default slot. The registry stays a Map (not a bare ref) so keying
  // it by an actual connection name is an additive change — see docs/BACKLOG.md item H —
  // but `get()` deliberately takes NO connectionName: exposing one would advertise a
  // lookup that always misses in v1 and returns `err(HostNotInitialized)`.
  static get(): TransactionHost | undefined {
    return registry.get(DEFAULT_KEY);
  }

  get tx(): unknown {
    return this.#manager.getTransactionClient();
  }

  isTransactionActive(): boolean {
    return this.#manager.isTransactionActive();
  }

  /** Open a transaction as an `await using` scope (explicit resource management).
   *  Rolls back on dispose unless `commit()` is called; returns `err(...)` (never throws)
   *  if the transaction cannot start. NOTE: a scope does not set the ALS context, so the
   *  injected `DRIZZLE_TX_CLIENT` proxy will not auto-join it — use `scope.tx` explicitly. */
  begin(options?: BeginOptions): Promise<Result<TransactionScope<unknown>, DrizzleTxError>> {
    return this.#manager.begin(options);
  }
}
