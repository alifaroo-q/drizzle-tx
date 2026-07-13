import { type DrizzleTxError, transactionAborted } from './errors.js';
import type { TxLogger } from './logger.js';
import { err, ok, type Result } from './result.js';

/** Internal sentinel: a scope disposed without `commit()` returns this `err` to roll back. */
const SCOPE_ROLLBACK: unique symbol = Symbol('drizzle-tx:scope-rollback');

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

/** Bridge a callback-scoped transaction runner to a block-scoped `await using` handle.
 *  `runNewTransaction` starts a new top-level transaction and runs the passed work inside it;
 *  `captureClient` returns the active tx client (called from inside that work). */
export async function openScope<TClient>(
  runNewTransaction: (
    work: () => Promise<Result<void, symbol>>,
  ) => Promise<Result<void, symbol | DrizzleTxError>>,
  captureClient: () => TClient,
  logger: TxLogger,
  disposeTimeoutMs?: number,
): Promise<Result<TransactionScope<TClient>, DrizzleTxError>> {
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
  const settled = runNewTransaction(async () => {
    capturedClient = captureClient();
    markStarted();
    await gate;
    return outcome === 'commit' ? ok(undefined) : err(SCOPE_ROLLBACK);
  });

  // Proceed once the tx has begun (client captured) OR it ended early (start failed).
  await Promise.race([started, settled]);
  if (capturedClient === undefined) {
    const early = await settled;
    return early.ok
      ? err(
          transactionAborted({
            message: 'transaction closed before it started',
            sqlState: undefined,
            cause: new Error('transaction closed before it started'),
          }),
        )
      : err(early.error as DrizzleTxError);
  }

  let backstop: ReturnType<typeof setTimeout> | undefined;

  // Track self-termination: if the transaction ends on its own (e.g. the connection drops) before
  // the caller disposes, `settled` resolves early — the backstop must NOT then warn about a
  // "forgotten" scope, because there is nothing left to reclaim.
  let hasSettled = false;
  const markSettled = () => {
    hasSettled = true;
  };
  settled.then(markSettled, markSettled);

  const scope: TransactionScope<TClient> = {
    tx: capturedClient,
    commit: () => {
      outcome = 'commit';
    },
    rollback: () => {
      outcome = 'rollback';
    },
    [Symbol.asyncDispose]: async () => {
      if (backstop !== undefined) clearTimeout(backstop); // normal dispose disarms the backstop
      releaseGate();
      const result = await settled;
      // Disposal never throws (no-throw model). A genuine commit/rollback failure (not the
      // internal rollback sentinel) is surfaced via the logger; use withTransaction() when
      // you need to handle that failure as a Result value.
      if (!result.ok && result.error !== SCOPE_ROLLBACK) {
        logger.warn(`transaction scope failed to settle: ${String(result.error)}`);
      }
    },
  };

  // R5 backstop (ADR-0014): opt-in, default OFF. On fire, do what a forgotten dispose would —
  // force default-deny rollback + release the connection + warn loudly. Never throws.
  // Strictly positive only: a non-positive `disposeTimeoutMs` is treated as OFF (matching the
  // unset / non-finite framing) — `0`/negative would otherwise arm an immediate rollback that
  // reclaims still-live work, the opposite of the "forgotten scope" contract.
  if (disposeTimeoutMs !== undefined && Number.isFinite(disposeTimeoutMs) && disposeTimeoutMs > 0) {
    backstop = setTimeout(() => {
      if (hasSettled) return; // transaction already ended on its own — nothing to reclaim
      outcome = 'rollback'; // override any prior commit() — leak reclaim
      releaseGate(); // settles the parked work → adapter ROLLBACK + release
      logger.warn(
        `transaction scope not disposed within ${disposeTimeoutMs}ms — forced rollback; ` +
          'use `await using` to guarantee disposal (this backstop reclaims a forgotten connection, ' +
          'it is not a work deadline).',
      );
    }, disposeTimeoutMs);
    backstop.unref?.(); // never keep the event loop alive for the backstop
  }

  return ok(scope);
}
