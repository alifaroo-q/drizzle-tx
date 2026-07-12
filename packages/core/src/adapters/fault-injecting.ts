import { consoleLogger, type TxLogger } from '../logger.js';
import type { TxOptions } from '../options.js';
import type { TransactionAdapter } from './port.js';

/** A fake pg `DatabaseError`: a 5-char SQLSTATE `.code` + a string `.severity` — the exact
 *  structural markers `classifyCaught` reads (ADR-0012 §3). No `pg` import. */
export function fakePgError(
  code: string,
  message = `pg error ${code}`,
): { code: string; message: string; severity: string; routine: string; name: string } {
  return { code, message, severity: 'ERROR', routine: 'exec_simple_query', name: 'error' };
}

/** Code-less client-side socket loss (the drizzle/pg "Connection terminated" shape), or — when a
 *  libuv `code` is given — a raw socket error carrying `.syscall`. Both classify to ConnectionLost
 *  (socket-first precedence keeps `sqlState` undefined). */
export function socketError(opts?: { message?: string; code?: string }): Error {
  const e = new Error(opts?.message ?? 'Connection terminated unexpectedly');
  if (opts?.code) Object.assign(e, { code: opts.code, syscall: 'read' });
  return e;
}

type FakePgError = ReturnType<typeof fakePgError>;

export const pgSerializationFailure = (): FakePgError =>
  fakePgError('40001', 'could not serialize access');
export const pgDeadlock = (): FakePgError => fakePgError('40P01', 'deadlock detected');
export const pgAdminShutdown = (): FakePgError =>
  fakePgError('57P01', 'terminating connection due to administrator command');

export type TxPhase =
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'savepoint'
  | 'release-savepoint'
  | 'rollback-to-savepoint';

export interface FaultInjection {
  readonly error: unknown;
  readonly times?: number;
}

export interface FaultInjectingDrizzleAdapterOptions {
  readonly logger?: TxLogger;
  readonly quiet?: boolean;
  readonly failAt?: Partial<Record<TxPhase, unknown | FaultInjection>>;
}

export interface FaultBoundaryLogEntry {
  readonly kind: 'new-root' | 'nested';
  readonly outcome: 'commit' | 'rollback';
  readonly failedAt?: TxPhase;
}

const isInjection = (v: unknown): v is FaultInjection =>
  typeof v === 'object' && v !== null && 'error' in v;

interface Armed {
  error: unknown;
  remaining: number;
}

export class FaultInjectingDrizzleAdapter<TClient> implements TransactionAdapter<TClient> {
  readonly #client: TClient;
  readonly #armed = new Map<TxPhase, Armed>();
  #boundaryLog: FaultBoundaryLogEntry[] = [];
  readonly supportsIndependentTransactions = true;

  constructor(client: TClient, options?: FaultInjectingDrizzleAdapterOptions) {
    this.#client = client;
    const logger = options?.logger ?? consoleLogger;
    if (!options?.quiet)
      logger.warn('FaultInjectingDrizzleAdapter: fault injection enabled — testing only.');
    for (const [phase, v] of Object.entries(options?.failAt ?? {})) this.#arm(phase as TxPhase, v);
  }

  getBaseClient(): TClient {
    return this.#client;
  }
  getBoundaryLog(): readonly FaultBoundaryLogEntry[] {
    return this.#boundaryLog;
  }
  resetBoundaryLog(): void {
    this.#boundaryLog = [];
  }

  failOn(phase: TxPhase, error: unknown): this {
    this.#arm(phase, error);
    return this;
  }
  failOnce(phase: TxPhase, error: unknown): this {
    this.#arm(phase, { error, times: 1 });
    return this;
  }
  clear(phase?: TxPhase): this {
    if (phase) this.#armed.delete(phase);
    else this.#armed.clear();
    return this;
  }

  wrapWithTransaction<T>(_o: TxOptions | undefined, work: (tx: TClient) => Promise<T>): Promise<T> {
    return this.#boundary('new-root', 'begin', 'commit', 'rollback', work);
  }
  wrapWithNestedTransaction<T>(_p: TClient, work: (sp: TClient) => Promise<T>): Promise<T> {
    return this.#boundary(
      'nested',
      'savepoint',
      'release-savepoint',
      'rollback-to-savepoint',
      work,
    );
  }

  #arm(phase: TxPhase, v: unknown | FaultInjection): void {
    const inj = isInjection(v) ? v : { error: v, times: Number.POSITIVE_INFINITY };
    this.#armed.set(phase, { error: inj.error, remaining: inj.times ?? Number.POSITIVE_INFINITY });
  }

  /** Peek+consume: returns the injected error if this phase is armed with remaining > 0, else undefined. */
  #take(phase: TxPhase): unknown | undefined {
    const a = this.#armed.get(phase);
    if (!a || a.remaining <= 0) return undefined;
    a.remaining -= 1;
    if (a.remaining <= 0) this.#armed.delete(phase);
    return a.error;
  }

  async #boundary<T>(
    kind: FaultBoundaryLogEntry['kind'],
    pre: TxPhase,
    post: TxPhase,
    undo: TxPhase,
    work: (c: TClient) => Promise<T>,
  ): Promise<T> {
    // PRE (BEGIN / SAVEPOINT) — before work; a fault here means work never runs.
    const preErr = this.#take(pre);
    if (preErr !== undefined) {
      this.#log(kind, 'rollback', pre);
      throw preErr;
    }

    let injectedAt: TxPhase | undefined;
    try {
      const value = await work(this.#client);
      const postErr = this.#take(post); // POST (COMMIT / RELEASE) runs inside the try (drizzle)
      if (postErr !== undefined) {
        injectedAt = post;
        throw postErr;
      }
      this.#log(kind, 'commit');
      return value;
    } catch (e) {
      // UNDO (ROLLBACK / ROLLBACK TO SAVEPOINT) — may itself be injected → shadows e (R2 path).
      const undoErr = this.#take(undo);
      if (undoErr !== undefined) {
        this.#log(kind, 'rollback', undo);
        throw undoErr;
      }
      this.#log(kind, 'rollback', injectedAt); // injectedAt set only if the POST fault fired
      throw e;
    }
  }

  #log(
    kind: FaultBoundaryLogEntry['kind'],
    outcome: 'commit' | 'rollback',
    failedAt?: TxPhase,
  ): void {
    this.#boundaryLog.push(failedAt ? { kind, outcome, failedAt } : { kind, outcome });
  }
}
