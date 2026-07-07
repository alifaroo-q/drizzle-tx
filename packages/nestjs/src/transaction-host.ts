import type {
  DrizzleTxError,
  Propagation,
  Result,
  TransactionManager,
  TransactionWork,
  TxOptions,
} from '@drizzle-tx/core';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_TX_MANAGER } from './tokens.js';

const registry = new Map<string, TransactionHost>();
const DEFAULT_KEY = 'default';

@Injectable()
export class TransactionHost {
  readonly #manager: TransactionManager<unknown>;

  constructor(@Inject(DRIZZLE_TX_MANAGER) manager: TransactionManager<unknown>) {
    this.#manager = manager;
    registry.set(DEFAULT_KEY, this);
  }

  static get(connectionName?: string): TransactionHost | undefined {
    return registry.get(connectionName ?? DEFAULT_KEY);
  }

  get tx(): unknown {
    return this.#manager.getTransactionClient();
  }

  isTransactionActive(): boolean {
    return this.#manager.isTransactionActive();
  }

  // Overloads mirror TransactionManager.withTransaction so callers keep full type safety.
  withTransaction<T, E>(work: TransactionWork<T, E>): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    propagation: Propagation,
    work: TransactionWork<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    options: TxOptions,
    work: TransactionWork<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    propagation: Propagation,
    options: TxOptions,
    work: TransactionWork<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    a: Propagation | TxOptions | TransactionWork<T, E>,
    b?: TxOptions | TransactionWork<T, E>,
    c?: TransactionWork<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    // Forward the variadic overload args to the manager. Overloaded functions can't be
    // called with union-typed args, so the method is cast to a single precise call
    // signature (not `any`) — the Result return type is preserved end-to-end. Kept as a
    // member-call expression so `this` stays bound to the manager.
    return (
      this.#manager.withTransaction as (
        ...args: unknown[]
      ) => Promise<Result<T, E | DrizzleTxError>>
    )(a, b, c);
  }
}
