import type { TransactionAdapter } from './adapter.js';
import type { TxLogger } from './logger.js';
import { consoleLogger } from './logger.js';
import type { TxOptions } from './options.js';

export interface NoOpBoundaryLogEntry {
  readonly kind: 'new-root' | 'nested';
  readonly outcome: 'commit' | 'rollback';
}

export interface NoOpDrizzleAdapterOptions {
  readonly logger?: TxLogger;
  readonly quiet?: boolean;
}

export class NoOpDrizzleAdapter<TClient> implements TransactionAdapter<TClient> {
  readonly #client: TClient;
  readonly #logger: TxLogger;
  #boundaryLog: NoOpBoundaryLogEntry[] = [];
  readonly supportsIndependentTransactions = true;

  constructor(client: TClient, options?: NoOpDrizzleAdapterOptions) {
    this.#client = client;
    this.#logger = options?.logger ?? consoleLogger;
    if (!options?.quiet)
      this.#logger.warn('NoOpDrizzleAdapter: transactions disabled — testing only.');
  }

  getBaseClient(): TClient {
    return this.#client;
  }

  getBoundaryLog(): readonly NoOpBoundaryLogEntry[] {
    return this.#boundaryLog;
  }

  resetBoundaryLog(): void {
    this.#boundaryLog = [];
  }

  async wrapWithTransaction<T>(
    _options: TxOptions | undefined,
    work: (tx: TClient) => Promise<T>,
  ): Promise<T> {
    return this.#runBoundary('new-root', () => work(this.#client));
  }

  async wrapWithNestedTransaction<T>(
    _parent: TClient,
    work: (sp: TClient) => Promise<T>,
  ): Promise<T> {
    return this.#runBoundary('nested', () => work(this.#client));
  }

  async #runBoundary<T>(kind: NoOpBoundaryLogEntry['kind'], work: () => Promise<T>): Promise<T> {
    try {
      const value = await work();
      this.#boundaryLog.push({ kind, outcome: 'commit' });
      return value;
    } catch (e) {
      this.#boundaryLog.push({ kind, outcome: 'rollback' });
      throw e;
    }
  }
}
