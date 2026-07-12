# Spec: failure-injecting `/testing` adapter (`FaultInjectingDrizzleAdapter`) + NoOp false-pass sharpening

Resolves issue #28 (audit gaps **T4b** + **T4a**). Deliverable per the wayfinder map: **the spec** — the injection API surface, how it's configured, how it carries a SQLSTATE. **The build is execution.** Ships from `@drizzle-tx/core/testing` (its one extra published surface, [ADR-0007](../../adr/0007-observable-no-op-testing-adapter.md)). Test vehicle for the [ADR-0012](../../adr/0012-structured-transaction-failure-error-model.md) error model.

Design forks decided HITL (#28, prototype ticket): **declarative per-phase** injection · **sibling class** to `NoOpDrizzleAdapter` · **fine-grained phases** matching drizzle's real SQL ops.

## Why this adapter

No JS transaction peer ships failure injection — this is a category lead. It lets the resilience + coverage scenario tests (R1, R2, T2) run **in-process, no Docker fault-injection**:

- Unit-test `classifyRollback` → `SerializationFailure`/`DeadlockDetected`/`ConnectionLost`/`TransactionAborted` (ADR-0012 §3) by throwing a **fake pg error with a settable `.code`**, without provoking a real serialization conflict.
- Test **R1** ("ok-work still errs at COMMIT") by running work successfully, then throwing at COMMIT.
- Test **R2** (rollback-double-fault preserves `lostDomainError`) by failing `rollback` / `rollback-to-savepoint` *while unwinding a domain `err(E)`* — the adapter reproduces drizzle's exact error-shadowing so the manager's stash (ADR-0012 §2) is exercised end-to-end.

Like `NoOpDrizzleAdapter`: **one caller-supplied client, no real SQL, no isolation/durability.** It throws *where* BEGIN/COMMIT/ROLLBACK/savepoint would run — it does not run them.

## The injection API

### Phases (fine-grained — match drizzle's `node-postgres/session` SQL ops)

```ts
export type TxPhase =
  | 'begin'                  // BEGIN                 — fires before work
  | 'commit'                 // COMMIT                — fires after work resolves ok
  | 'rollback'               // ROLLBACK              — fires while unwinding (work err/throw)
  | 'savepoint'              // SAVEPOINT sp           — nested, before nested work
  | 'release-savepoint'      // RELEASE SAVEPOINT sp   — nested, after nested work ok
  | 'rollback-to-savepoint'; // ROLLBACK TO SAVEPOINT  — nested, while unwinding
```

New-root boundaries fire `begin`/`commit`/`rollback`; nested (savepoint) boundaries fire `savepoint`/`release-savepoint`/`rollback-to-savepoint`.

### Configuration — declarative per-phase, sticky by default

```ts
export interface FaultInjection {
  /** The error thrown when this phase runs. Use fakePgError/socketError helpers to carry a SQLSTATE or model socket loss. */
  readonly error: unknown;
  /** How many times to throw before this phase starts succeeding again. Default: Infinity (sticky). Use 1 for retry-style "fail once then succeed". */
  readonly times?: number;
}

export interface FaultInjectingDrizzleAdapterOptions {
  readonly logger?: TxLogger;
  readonly quiet?: boolean;
  /** Phases to fail from construction. Value may be a bare error (sticky) or a FaultInjection. */
  readonly failAt?: Partial<Record<TxPhase, unknown | FaultInjection>>;
}

export class FaultInjectingDrizzleAdapter<TClient> implements TransactionAdapter<TClient> {
  constructor(client: TClient, options?: FaultInjectingDrizzleAdapterOptions);

  // fluent, mid-test:
  failOn(phase: TxPhase, error: unknown): this;         // sticky
  failOnce(phase: TxPhase, error: unknown): this;        // times: 1
  clear(phase?: TxPhase): this;                          // clear one / all

  // observability (extends the NoOp boundary-log idea with the failed phase):
  getBoundaryLog(): readonly FaultBoundaryLogEntry[];
  resetBoundaryLog(): void;

  // TransactionAdapter seam:
  getBaseClient(): TClient;
  readonly supportsIndependentTransactions = true;       // like NoOp — REQUIRES_NEW runs the body
  wrapWithTransaction<T>(o: TxOptions | undefined, work: (tx: TClient) => Promise<T>): Promise<T>;
  wrapWithNestedTransaction<T>(parent: TClient, work: (sp: TClient) => Promise<T>): Promise<T>;
}

export interface FaultBoundaryLogEntry {
  readonly kind: 'new-root' | 'nested';
  readonly outcome: 'commit' | 'rollback';
  /** The injected phase that fired, if any — the assertion surface for "did the fault land here?". */
  readonly failedAt?: TxPhase;
}
```

### SQLSTATE / error-shape helpers (also from `/testing`)

The whole point is carrying a classifiable error **without importing `pg`**. Helpers produce values shaped exactly as `classifyRollback` recognizes structurally (ADR-0012 §3):

```ts
/** A fake pg DatabaseError: { code, message, severity, routine, name }. `code` is the 5-char SQLSTATE. */
export function fakePgError(code: string, message?: string): { code: string; message: string; severity: string; routine?: string; name: string };

/** Code-less client-side socket loss — the "Connection terminated" / libuv shape. Default: message 'Connection terminated unexpectedly' (no .code). Pass a libuv code (ECONNRESET/EPIPE/…) to model a raw socket error with .syscall. */
export function socketError(opts?: { message?: string; code?: string }): Error;

// convenience wrappers (thin over fakePgError):
export const pgSerializationFailure = () => fakePgError('40001', 'could not serialize access');   // → SerializationFailure
export const pgDeadlock            = () => fakePgError('40P01', 'deadlock detected');             // → DeadlockDetected
export const pgAdminShutdown       = () => fakePgError('57P01', 'terminating connection');         // → ConnectionLost (server-initiated)
```

`socketError()` (code-less) and `socketError({ code: 'ECONNRESET' })` both classify to `ConnectionLost` via ADR-0012's socket-first precedence.

## Behavior — reproduce drizzle's shadowing exactly

The boundary logic mirrors `drizzle-orm/node-postgres/session` (verified rc.4 — see ADR-0012 Evidence) so the fault lands where the real driver's would:

```ts
// new-root (savepoint path is identical with savepoint/release-savepoint/rollback-to-savepoint):
async #boundary(kind, work) {
  this.#throwIfInjected('begin');                 // BEGIN fails before work
  try {
    const value = await work(this.#client);
    this.#throwIfInjected('commit');              // COMMIT fails AFTER ok-work → R1
    this.#log(kind, 'commit');
    return value;
  } catch (e) {
    const rollbackErr = this.#peekInjected('rollback');
    if (rollbackErr) {                            // ROLLBACK fails → SHADOWS e (matches drizzle line 60/61)
      this.#consume('rollback'); this.#log(kind, 'rollback', 'rollback');
      throw rollbackErr;                           // e (the RollbackSignal carrying domain E) is lost → R2 path
    }
    this.#log(kind, 'rollback');
    throw e;                                       // rollback ok → rethrow original (RollbackSignal survives)
  }
}
```

This is what makes R2 testable: fail `rollback` while `e` is a `RollbackSignal<E>`, and the manager's `classifyRollback(e, inFlight)` must surface the infra error with `lostDomainError === E`.

## Worked test examples (the spec's acceptance shape)

```ts
// 1 — classification: COMMIT throws 40001 → SerializationFailure
const a = new FaultInjectingDrizzleAdapter(mockDb, { failAt: { commit: pgSerializationFailure() }, quiet: true });
const m = new TransactionManager(a);
const r = await m.withTransaction(async () => ok('done'));   // work succeeds; COMMIT throws
expect(r).toEqual(err({ kind: 'SerializationFailure', sqlState: '40001', message: expect.any(String), cause: expect.anything() }));
expect(a.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'rollback', failedAt: 'commit' }]);

// 2 — R1: ok(value) work still errs at commit
const r1 = await m.withTransaction(async () => ok(42));
expect(r1.ok).toBe(false);   // documented contract: ok-work may err at COMMIT

// 3 — R2: domain err + ROLLBACK fails → infra trumps, E preserved
const b = new FaultInjectingDrizzleAdapter(mockDb, { failAt: { rollback: pgAdminShutdown() }, quiet: true });
const r2 = await new TransactionManager(b).withTransaction(async () => err({ kind: 'NotFound' }));
expect(r2).toEqual(err({ kind: 'ConnectionLost', sqlState: '57P01', message: expect.any(String), cause: expect.anything(),
                         lostDomainError: { kind: 'NotFound' } }));   // E not swallowed

// 4 — nested double-fault: ROLLBACK TO SAVEPOINT fails
const c = new FaultInjectingDrizzleAdapter(mockDb, { failAt: { 'rollback-to-savepoint': socketError() }, quiet: true });
// … NESTED work returns err → savepoint rollback fails → ConnectionLost{ sqlState: undefined, lostDomainError: E }

// 5 — retry-style one-shot: fail first commit, succeed on retry
const d = new FaultInjectingDrizzleAdapter(mockDb, { quiet: true }).failOnce('commit', pgDeadlock());
```

## T4a — sharpen the NoOp false-pass signal (docs, no heavy surgery)

`NoOpDrizzleAdapter` runs work against one client with **no BEGIN/COMMIT/ROLLBACK and no data rollback** — a test that mutates the mock and asserts "it was rolled back" **false-passes** (nothing was ever persisted or reverted). Sharpen the signal by framing the **boundary log as the sanctioned assertion surface** and redirecting data-effect/failure assertions elsewhere. No behavior change.

**Class-level JSDoc** on `NoOpDrizzleAdapter` (spec text):

> Asserts propagation **decisions** via `getBoundaryLog()` — which boundaries were entered and their commit/rollback outcome. It does **not** issue SQL, persist data, or roll back mutations: `err(...)` yields a faithful `Result`, but the mock client is simply never changed. **Do not assert data effects or failure classification against this adapter** — a "rolled back" assertion on mutated mock state false-passes. For data-effect assertions use real Postgres; for failure/`DrizzleTxError` classification use `FaultInjectingDrizzleAdapter`.

**README `/testing` callout** (spec text): a short table steering each assertion kind to the right vehicle —

| Want to assert… | Use |
|---|---|
| which propagation boundary was taken (wiring) | `NoOpDrizzleAdapter` + `getBoundaryLog()` |
| a `DrizzleTxError` variant / SQLSTATE classification | `FaultInjectingDrizzleAdapter` + `fakePgError` |
| real commit/rollback **data** effects | real Postgres (Testcontainers) |

## Consequences / build notes (execution)

- **New `/testing` exports:** `FaultInjectingDrizzleAdapter`, `FaultInjectingDrizzleAdapterOptions`, `FaultInjection`, `FaultBoundaryLogEntry`, `TxPhase`, `fakePgError`, `socketError`, `pgSerializationFailure`/`pgDeadlock`/`pgAdminShutdown`. Adds to the existing `testing.ts` barrel; `attw`/`publint --strict` already cover the subpath (ADR-0007).
- **Sibling class**, not a subclass — keeps `NoOpDrizzleAdapter` minimal and ADR-0007's "no-op = does nothing" identity intact. The boundary-log shape is shared *by convention* (`FaultBoundaryLogEntry` extends the idea with `failedAt`), not by inheritance.
- **No `pg` dependency** — helpers hand-roll the error shape; this is the same structural discipline core already uses (`isPoolTimeoutError`, `isPoolBacked`).
- **Gated by ADR-0012** (now closed): the variants/classification it injects against are fixed. This adapter is the **test vehicle** for that model's implementation — build them together in execution (the ADR-0012 impl PR can land its unit tests on this adapter).
- **`nestjs` parity:** out of scope here; `@drizzle-tx/nestjs/testing` currently wraps the NoOp override — a matching fault-injecting override can follow if demand appears (not speced now).
- Docs (T4a JSDoc + README callout) are small and may execute in place alongside the build.
