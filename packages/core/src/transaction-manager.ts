import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionAdapter } from './adapter.js';
import { type DrizzleTxError, notPoolBacked, transactionAborted } from './errors.js';
import { consoleLogger, type TxLogger } from './logger.js';
import type { TxOptions } from './options.js';
import { Propagation } from './propagation.js';
import { err, ok, type Result } from './result.js';

interface TxContext<TClient> {
  client: TClient;
  active: boolean;
}

/** Internal throw used ONLY to trigger a rollback; caught at the same boundary. */
class RollbackSignal<E> {
  // Explicit field + assignment (not a constructor parameter property) to satisfy
  // `erasableSyntaxOnly` — parameter properties emit non-erasable runtime code.
  readonly payload: E;
  constructor(payload: E) {
    this.payload = payload;
  }
}

type Work<T, E> = () => Promise<Result<T, E>>;

export interface TransactionManagerOptions {
  readonly logger?: TxLogger;
}

export class TransactionManager<TClient> {
  readonly #als = new AsyncLocalStorage<TxContext<TClient>>();
  readonly #adapter: TransactionAdapter<TClient>;
  readonly #logger: TxLogger;

  constructor(adapter: TransactionAdapter<TClient>, options?: TransactionManagerOptions) {
    this.#adapter = adapter;
    this.#logger = options?.logger ?? consoleLogger;
  }

  getTransactionClient(): TClient {
    return this.#als.getStore()?.client ?? this.#adapter.getBaseClient();
  }

  isTransactionActive(): boolean {
    return this.#als.getStore()?.active ?? false;
  }

  // Overloads mirror the imperative API.
  withTransaction<T, E>(work: Work<T, E>): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    propagation: Propagation,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    options: TxOptions,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    propagation: Propagation,
    options: TxOptions,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    a: Propagation | TxOptions | Work<T, E>,
    b?: TxOptions | Work<T, E>,
    c?: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    let propagation: Propagation = Propagation.Required;
    let options: TxOptions | undefined;
    let work: Work<T, E>;
    if (typeof a === 'function') {
      work = a;
    } else if (typeof a === 'string') {
      propagation = a;
      if (typeof b === 'function') work = b;
      else {
        options = b as TxOptions;
        work = c as Work<T, E>;
      }
    } else {
      options = a;
      work = b as Work<T, E>;
    }
    return this.#run(propagation, options, work);
  }

  #run<T, E>(
    propagation: Propagation,
    options: TxOptions | undefined,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    const active = this.isTransactionActive();
    switch (propagation) {
      case Propagation.Required:
        return active ? this.#join(options, work) : this.#newTransaction(options, work);
      case Propagation.RequiresNew:
        if (active && !this.#adapter.supportsIndependentTransactions) {
          return Promise.resolve(err(notPoolBacked()));
        }
        return this.#newTransaction(options, work);
      case Propagation.Nested:
        return active ? this.#nested(options, work) : this.#newTransaction(options, work);
      default:
        // v1 supports only the three modes above; the type prevents others.
        return this.#newTransaction(options, work);
    }
  }

  /** Join: run work in the current context; no new BEGIN. Options are ignored (warn). */
  async #join<T, E>(
    options: TxOptions | undefined,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    this.#warnIfOptions(options, 'joining an existing transaction');
    return work();
  }

  async #newTransaction<T, E>(
    options: TxOptions | undefined,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    const ctx: TxContext<TClient> = { client: this.#adapter.getBaseClient(), active: true };
    try {
      const value = await this.#als.run(ctx, () =>
        this.#adapter.wrapWithTransaction(
          options,
          (client) => {
            ctx.client = client;
          },
          async () => this.#execute(work),
        ),
      );
      return ok(value);
    } catch (e) {
      return this.#fromThrow<T, E>(e);
    }
  }

  async #nested<T, E>(
    options: TxOptions | undefined,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    this.#warnIfOptions(options, 'a NESTED (savepoint) transaction');
    const parent = this.getTransactionClient();
    const ctx: TxContext<TClient> = { client: parent, active: true };
    try {
      const value = await this.#als.run(ctx, () =>
        this.#adapter.wrapWithNestedTransaction(
          parent,
          (client) => {
            ctx.client = client;
          },
          async () => this.#execute(work),
        ),
      );
      return ok(value);
    } catch (e) {
      return this.#fromThrow<T, E>(e);
    }
  }

  /** Run work; convert an `err` result into the rollback-triggering throw. */
  async #execute<T, E>(work: Work<T, E>): Promise<T> {
    const result = await work();
    if (!result.ok) throw new RollbackSignal(result.error);
    return result.value;
  }

  #fromThrow<T, E>(e: unknown): Result<T, E | DrizzleTxError> {
    if (e instanceof RollbackSignal) return err(e.payload as E);
    return err(transactionAborted(e));
  }

  #warnIfOptions(options: TxOptions | undefined, context: string): void {
    if (options && Object.keys(options).length > 0) {
      this.#logger.warn(
        `Transaction options are ignored for ${context}; isolation/access-mode apply only to a new top-level transaction.`,
      );
    }
  }
}
