import { AsyncLocalStorage } from 'node:async_hooks';

/** The immutable ALS payload. Presence of a store == a transaction is active. */
interface ActiveTx<TClient> {
  readonly client: TClient;
}

/** Deep module over AsyncLocalStorage: hides the store shape and the run()-only rule
 *  (enterWith is forbidden — ADR-0001). The store is constructed immutable; there is no
 *  setter for the client. */
export class TransactionContext<TClient> {
  readonly #als = new AsyncLocalStorage<ActiveTx<TClient>>();

  current(): TClient | undefined {
    return this.#als.getStore()?.client;
  }

  isActive(): boolean {
    return this.#als.getStore() !== undefined;
  }

  /** Establish an immutable transaction context for the async scope of `fn`. */
  run<T>(client: TClient, fn: () => Promise<T>): Promise<T> {
    return this.#als.run({ client }, fn);
  }
}
