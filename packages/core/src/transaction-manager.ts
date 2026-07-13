import type { TransactionAdapter } from './adapters/port.js';
import type { DrizzleTxError } from './errors.js';
import { consoleLogger, type TxLogger } from './logger.js';
import type { BeginOptions, TxOptions } from './options.js';
import type { Propagation } from './propagation.js';
import { normalizeArgs, planTransaction, type TransactionWork } from './propagation-plan.js';
import { err, type Independent, ok, type Result } from './result.js';
import { classifyRollback, toThrowable } from './rollback-boundary.js';
import { TransactionContext } from './transaction-context.js';
import { openScope, type TransactionScope } from './transaction-scope.js';

export type { TransactionWork } from './propagation-plan.js';

/** The `withTransaction` overload contract (incl. the REQUIRES_NEW `Independent` brand), derived
 *  from the manager so it can't drift. The single type every assembly site (core factory, NestJS
 *  host) binds `withTransaction` to. */
export type WithTransaction<TClient> = TransactionManager<TClient>['withTransaction'];

export interface TransactionManagerOptions {
  readonly logger?: TxLogger;
  /** Default `disposeTimeoutMs` for every `begin()` scope (per-call `begin({ disposeTimeoutMs })`
   *  overrides). Default OFF. See ADR-0014 R5. */
  readonly disposeTimeoutMs?: number;
}

export class TransactionManager<TClient> {
  readonly #ctx = new TransactionContext<TClient>();
  readonly #adapter: TransactionAdapter<TClient>;
  readonly #logger: TxLogger;
  readonly #disposeTimeoutMs: number | undefined;

  constructor(adapter: TransactionAdapter<TClient>, options?: TransactionManagerOptions) {
    this.#adapter = adapter;
    this.#logger = options?.logger ?? consoleLogger;
    this.#disposeTimeoutMs = options?.disposeTimeoutMs;
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
  // Overloads mirror the imperative API. REQUIRES_NEW literals come FIRST so a literal
  // argument resolves to the branded overload before the general `Propagation` one.
  /** REQUIRES_NEW runs on its OWN connection; its outcome is an `Independent<T,E>` — a value you
   *  inspect (`.ok`/`.value`/`.error`), NOT something to `return` directly from the outer work.
   *  `return inner` is a compile error (the error points at the outer `withTransaction(...)` call,
   *  not the return line). To propagate the inner outcome as the outer's, `return settle(inner)`
   *  consciously; to commit the outer regardless, `return ok(inner)`. */
  withTransaction<T, E>(
    propagation: 'REQUIRES_NEW',
    work: TransactionWork<T, E>,
  ): Promise<Independent<T, E | DrizzleTxError>>;
  /** REQUIRES_NEW runs on its OWN connection; its outcome is an `Independent<T,E>` — a value you
   *  inspect (`.ok`/`.value`/`.error`), NOT something to `return` directly from the outer work.
   *  `return inner` is a compile error (the error points at the outer `withTransaction(...)` call,
   *  not the return line). To propagate the inner outcome as the outer's, `return settle(inner)`
   *  consciously; to commit the outer regardless, `return ok(inner)`. */
  withTransaction<T, E>(
    propagation: 'REQUIRES_NEW',
    options: TxOptions,
    work: TransactionWork<T, E>,
  ): Promise<Independent<T, E | DrizzleTxError>>;
  // every other form → plain Result:
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
   *  REACTABILITY (E6, ADR-0014): because a scope commit-failure is logged and not returned,
   *  use `withTransaction(work)` — whose return surfaces the classified error — when you need to
   *  *react* to a commit failure as a `Result`. The scope is the explicit-`scope.tx` escape hatch;
   *  it opts out of implicit propagation (no ALS context).
   *  BACKSTOP (R5, ADR-0014): a `disposeTimeoutMs` (per-call, or a manager default) reclaims a
   *  *forgotten* scope — forced rollback + release + loud warn. Default OFF; prefer `await using`
   *  so disposal is guaranteed and the backstop never fires.
   *
   *  ```ts
   *  const opened = await manager.begin();
   *  if (!opened.ok) return opened;            // handle infra error as a value
   *  await using scope = opened.value;
   *  await scope.tx.insert(users).values(...); // explicit tx client (no ALS auto-join)
   *  scope.commit();                           // omit → rollback on scope exit
   *  ```
   */
  begin(options?: BeginOptions): Promise<Result<TransactionScope<TClient>, DrizzleTxError>> {
    // Split the scope-lifecycle control from the SQL tx options: `disposeTimeoutMs` drives the
    // leak backstop and must NOT ride into the adapter's `BEGIN` config object.
    const { disposeTimeoutMs: perCall, ...txOptions } = options ?? {};
    const disposeTimeoutMs = perCall ?? this.#disposeTimeoutMs;
    return openScope<TClient>(
      (work) => this.#newTransaction<void, symbol>(txOptions, work),
      () => this.getTransactionClient(),
      this.#logger,
      disposeTimeoutMs,
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

  /** The one transaction boundary: enter the adapter's wrap, run `work` in an immutable ALS
   *  context, translate err↔throw, and classify any caught failure — preserving a shadowed
   *  domain error (R2). Both new-root and nested transactions run through HERE (ADR-0013 §4),
   *  so the future lifecycle-observation seam and the retry loop attach in ONE place. */
  async #runInBoundary<T, E>(
    wrap: (run: (client: TClient) => Promise<T>) => Promise<T>,
    work: TransactionWork<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    let inFlight: { error: E } | undefined;
    try {
      const value = await wrap((client) =>
        this.#ctx.run(client, async () => {
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

  #newTransaction<T, E>(options: TxOptions | undefined, work: TransactionWork<T, E>) {
    return this.#runInBoundary<T, E>(
      (run) => this.#adapter.wrapWithTransaction(options, run),
      work,
    );
  }

  #nested<T, E>(work: TransactionWork<T, E>) {
    const parent = this.getTransactionClient();
    return this.#runInBoundary<T, E>(
      (run) => this.#adapter.wrapWithNestedTransaction(parent, run),
      work,
    );
  }

  #warnIgnoredOptions(context: string): void {
    this.#logger.warn(
      `Transaction options are ignored for ${context}; isolation/access-mode apply only to a new top-level transaction.`,
    );
  }
}
