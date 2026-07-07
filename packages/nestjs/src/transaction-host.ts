import type {
  DrizzleTxError,
  Propagation,
  Result,
  TransactionManager,
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

  withTransaction<T, E>(
    a: Propagation | TxOptions | (() => Promise<Result<T, E>>),
    b?: TxOptions | (() => Promise<Result<T, E>>),
    c?: () => Promise<Result<T, E>>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    // Delegate all overloads to the manager.
    // biome-ignore lint/suspicious/noExplicitAny: overload dispatch is delegated wholesale to the manager
    return (this.#manager.withTransaction as any)(a, b, c);
  }
}
