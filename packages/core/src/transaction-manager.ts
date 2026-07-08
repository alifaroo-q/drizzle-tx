import type { TransactionAdapter } from './adapter.js';
import { type DrizzleTxError, transactionAborted } from './errors.js';
import { consoleLogger, type TxLogger } from './logger.js';
import type { TxOptions } from './options.js';
import type { Propagation } from './propagation.js';
import { normalizeArgs, planTransaction } from './propagation-plan.js';
import { err, ok, type Result } from './result.js';
import { classifyRollback, toThrowable } from './rollback-boundary.js';
import { TransactionContext } from './transaction-context.js';

/** A unit of transactional work: an async function returning an explicit `Result`.
 *  Returning `err(...)` triggers a rollback (ADR-0003). */
export type TransactionWork<T, E> = () => Promise<Result<T, E>>;

/** Internal sentinel: a scope disposed without `commit()` returns this `err` to roll back. */
const SCOPE_ROLLBACK: unique symbol = Symbol('drizzle-tx:scope-rollback');

export interface TransactionManagerOptions {
  readonly logger?: TxLogger;
}

/** A block-scoped transaction handle for the `await using` API. Rolls back on dispose
 *  UNLESS `commit()` is called (default-deny, ADR-0002/0003).
 *
 *  IMPORTANT: unlike `withTransaction`, a scope does NOT establish the AsyncLocalStorage
 *  context (that requires a callback; `enterWith` is forbidden by ADR-0001). So the injected
 *  transactional-client proxy will NOT auto-join a scope — use `scope.tx` explicitly for
 *  queries, or use `withTransaction(work)` when you want implicit propagation. */
export interface TransactionScope<TClient> extends AsyncDisposable {
  /** The active transaction client — pass it explicitly to your queries. */
  readonly tx: TClient;
  /** Mark the transaction to COMMIT on dispose. */
  commit(): void;
  /** Mark the transaction to ROLL BACK on dispose (the default). */
  rollback(): void;
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
   *
   *  ```ts
   *  const opened = await manager.begin();
   *  if (!opened.ok) return opened;            // handle infra error as a value
   *  await using scope = opened.value;
   *  await scope.tx.insert(users).values(...); // explicit tx client (no ALS auto-join)
   *  scope.commit();                           // omit → rollback on scope exit
   *  ```
   */
  async begin(options?: TxOptions): Promise<Result<TransactionScope<TClient>, DrizzleTxError>> {
    let outcome: 'commit' | 'rollback' = 'rollback'; // default-deny
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let capturedClient: TClient | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    // Bridge the adapter's callback-scoped transaction to a block scope: the work callback
    // captures the tx client, then parks on `gate` — keeping the transaction open — until
    // dispose releases it and decides commit vs rollback.
    const settled = this.#newTransaction<void, symbol>(options, async () => {
      capturedClient = this.getTransactionClient();
      markStarted();
      await gate;
      return outcome === 'commit' ? ok(undefined) : err(SCOPE_ROLLBACK);
    });

    // Proceed once the tx has begun (client captured) OR it ended early (start failed).
    await Promise.race([started, settled]);
    if (capturedClient === undefined) {
      const early = await settled;
      return early.ok
        ? err(transactionAborted(new Error('transaction closed before it started')))
        : err(early.error as DrizzleTxError);
    }

    const scope: TransactionScope<TClient> = {
      tx: capturedClient,
      commit: () => {
        outcome = 'commit';
      },
      rollback: () => {
        outcome = 'rollback';
      },
      [Symbol.asyncDispose]: async () => {
        releaseGate();
        const result = await settled;
        // Disposal never throws (no-throw model). A genuine commit/rollback failure (not the
        // internal rollback sentinel) is surfaced via the logger; use withTransaction() when
        // you need to handle that failure as a Result value.
        if (!result.ok && result.error !== SCOPE_ROLLBACK) {
          this.#logger.warn(`transaction scope failed to settle: ${String(result.error)}`);
        }
      },
    };
    return ok(scope);
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
    try {
      const value = await this.#adapter.wrapWithTransaction(options, (tx) =>
        this.#ctx.run(tx, async () => toThrowable(await work())),
      );
      return ok(value);
    } catch (e) {
      return classifyRollback<E>(e);
    }
  }

  async #nested<T, E>(work: TransactionWork<T, E>): Promise<Result<T, E | DrizzleTxError>> {
    const parent = this.getTransactionClient();
    try {
      const value = await this.#adapter.wrapWithNestedTransaction(parent, (sp) =>
        this.#ctx.run(sp, async () => toThrowable(await work())),
      );
      return ok(value);
    } catch (e) {
      return classifyRollback<E>(e);
    }
  }

  #warnIgnoredOptions(context: string): void {
    this.#logger.warn(
      `Transaction options are ignored for ${context}; isolation/access-mode apply only to a new top-level transaction.`,
    );
  }
}
