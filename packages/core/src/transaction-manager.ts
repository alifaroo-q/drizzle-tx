import type { TransactionAdapter } from './adapters/port.js';
import type { DrizzleTxError } from './errors.js';
import { consoleLogger, type TxLogger } from './logger.js';
import type { TxOptions } from './options.js';
import type { Propagation } from './propagation.js';
import { normalizeArgs, planTransaction, type TransactionWork } from './propagation-plan.js';
import { err, ok, type Result } from './result.js';
import { classifyRollback, toThrowable } from './rollback-boundary.js';
import { TransactionContext } from './transaction-context.js';
import { openScope, type TransactionScope } from './transaction-scope.js';

export type { TransactionWork } from './propagation-plan.js';

export interface TransactionManagerOptions {
  readonly logger?: TxLogger;
}

export class TransactionManager<TClient> {
  readonly #ctx = new TransactionContext<TClient>();
  readonly #adapter: TransactionAdapter<TClient>;
  readonly #logger: TxLogger;

  constructor(adapter: TransactionAdapter<TClient>, options?: TransactionManagerOptions) {
    this.#adapter = adapter;
    this.#logger = options?.logger ?? consoleLogger;
  }

  getTransactionClient(): TClient {
    return this.#ctx.current() ?? this.#adapter.getBaseClient();
  }

  isTransactionActive(): boolean {
    return this.#ctx.isActive();
  }

  /** NOTE (R1, ADR-0012): a work fn returning `ok(value)` can still resolve to `err(...)` —
   *  COMMIT runs inside the transaction boundary, so a deferred-constraint or serialization
   *  failure at commit surfaces as the classified variant (e.g. SerializationFailure at commit). */
  // Overloads mirror the imperative API.
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
    const { propagation, options, work } = normalizeArgs(a, b, c);
    return this.#run(propagation, options, work);
  }

  /** Open a transaction as an `await using` scope (explicit resource management).
   *  Returns `err(...)` — never throws — if the transaction cannot be started. The scope
   *  rolls back on dispose unless `commit()` is called. The connection is held open for the
   *  scope's lifetime (like a manual `BEGIN`), so pool-sizing/deadlock caveats apply (ADR-0002).
   *  NOTE (R1, ADR-0012): a `commit()`ed scope can still fail at COMMIT (deferred-constraint /
   *  serialization); that settle failure is surfaced via the logger, not as a Result here.
   *
   *  ```ts
   *  const opened = await manager.begin();
   *  if (!opened.ok) return opened;            // handle infra error as a value
   *  await using scope = opened.value;
   *  await scope.tx.insert(users).values(...); // explicit tx client (no ALS auto-join)
   *  scope.commit();                           // omit → rollback on scope exit
   *  ```
   */
  begin(options?: TxOptions): Promise<Result<TransactionScope<TClient>, DrizzleTxError>> {
    return openScope<TClient>(
      (work) => this.#newTransaction<void, symbol>(options, work),
      () => this.getTransactionClient(),
      this.#logger,
    );
  }

  #run<T, E>(
    propagation: Propagation,
    options: TxOptions | undefined,
    work: TransactionWork<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    const plan = planTransaction({
      propagation,
      active: this.isTransactionActive(),
      supportsIndependentTransactions: this.#adapter.supportsIndependentTransactions,
      options,
    });
    switch (plan.kind) {
      case 'join':
        if (plan.ignoredOptions) this.#warnIgnoredOptions('joining an existing transaction');
        return work();
      case 'new-root':
        return this.#newTransaction(plan.options, work);
      case 'nested':
        if (plan.ignoredOptions) this.#warnIgnoredOptions('a NESTED (savepoint) transaction');
        // The 'nested' variant has no `options` field (savepoint isolation is fixed at the
        // outer tx), and `#nested` ignores options entirely.
        return this.#nested(work);
      case 'reject':
        return Promise.resolve(err(plan.error));
    }
  }

  async #newTransaction<T, E>(
    options: TxOptions | undefined,
    work: TransactionWork<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    let inFlight: { error: E } | undefined;
    try {
      const value = await this.#adapter.wrapWithTransaction(options, (tx) =>
        this.#ctx.run(tx, async () => {
          const r = await work();
          if (!r.ok) inFlight = { error: r.error };
          return toThrowable(r);
        }),
      );
      return ok(value);
    } catch (e) {
      return classifyRollback<E>(e, inFlight);
    }
  }

  async #nested<T, E>(work: TransactionWork<T, E>): Promise<Result<T, E | DrizzleTxError>> {
    const parent = this.getTransactionClient();
    let inFlight: { error: E } | undefined;
    try {
      const value = await this.#adapter.wrapWithNestedTransaction(parent, (sp) =>
        this.#ctx.run(sp, async () => {
          const r = await work();
          if (!r.ok) inFlight = { error: r.error };
          return toThrowable(r);
        }),
      );
      return ok(value);
    } catch (e) {
      return classifyRollback<E>(e, inFlight);
    }
  }

  #warnIgnoredOptions(context: string): void {
    this.#logger.warn(
      `Transaction options are ignored for ${context}; isolation/access-mode apply only to a new top-level transaction.`,
    );
  }
}
