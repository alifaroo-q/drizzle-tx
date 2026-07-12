# Structured transaction-failure error model — SQLSTATE-bearing fields + named retryable/triage variants

**Status: Accepted (spec; implementation is execution-backlog).** Designs the structured transaction-failure error model that folds audit gaps **G2** (#20), **R3 + R1 + R2** (#21). The **highest-leverage node** of the quality bar (Synthesis [#25](https://github.com/alifaroo-q/drizzle-tx/issues/25)): it unblocks retry, OTel error attributes, and resilience triage. Scoped by [ADR-0011](0011-result-is-the-core-adapter-author-contract.md) — this is an **adapter-author / core-contract** surface (`DrizzleTxError`), not an app-dev one. Backed by primary-source research (PostgreSQL Appendix A, node-postgres `pg-protocol`/`pg` source, drizzle-orm `node-postgres/session` source; verified against the pinned `drizzle-orm@1.0.0-rc.4` locally), 2026-07-12.

## Context

Today the rollback boundary collapses every transaction-body failure into one variant:

```ts
{ kind: 'TransactionAborted'; cause: unknown }   // errors.ts
```

`classifyRollback` ([rollback-boundary.ts](../../packages/core/src/rollback-boundary.ts)) produces it for *everything* that isn't a `RollbackSignal` or a pool timeout. That erases the structure three "Do Now" roadmap features need, and it is below the bar the reference backend's own `TypedError{ type, message, details, cause }` already sets:

- **G2 / R3** — retry-on-`40001`/`40P01` (roadmap Medium #1) can't classify retryable: the SQLSTATE is gone. OTel error attributes have nothing to read. Resilience triage can't tell connection-loss (infra) from a code bug. `40001`, `40P01`, connection-loss, COMMIT-failure, and "your code threw" all fold into one opaque variant with no `.message`.
- **R1** — a work fn that returns `ok(value)` can still fail: COMMIT runs *inside* drizzle's `try` (confirmed in source — see Evidence), so a deferred-constraint violation or a serialization failure surfacing at COMMIT throws and the transaction resolves to `err(...)`. This contract is undocumented and untested.
- **R2** — on `err(E)`, `toThrowable` throws a `RollbackSignal<E>`; drizzle catches it and runs `ROLLBACK`, then `throw error` re-raises the original **only if ROLLBACK succeeded**. The `ROLLBACK` is *not* in its own try/catch (confirmed in source), so if it throws, the rollback error shadows the `RollbackSignal` and the consumer's `E` is **swallowed** — `classifyRollback` never sees it.

The hard constraint throughout: **no `pg` import in core.** Classification must be structural — read `.code`/`.message`/markers off the caught value — the same discipline `isPoolTimeoutError` already follows reading `.constructor.name`.

## Decision

### 1. The shape — structured fields on **every** transaction-body failure, **plus** named variants

Every transaction-body failure carries a structured triad; the top retryable/triage classes get a named `kind`. Assembly/pool variants (`PoolConnectionTimeout`, `HostNotInitialized`, `NotPoolBacked`) are *not* transaction-body failures — they carry no SQLSTATE and are unchanged.

```ts
/** Structured fields carried by every transaction-body failure. */
interface TxFailureFields {
  /** Human-readable message — the underlying error's `.message`, or a variant default.
   *  (Fixes "TransactionAborted has no .message".) */
  readonly message: string;
  /** The 5-char Postgres SQLSTATE when the failure carried one (`err.code`);
   *  `undefined` for socket-level connection loss and non-DB throws. */
  readonly sqlState: string | undefined;
  /** The underlying caught error — a pg `DatabaseError`, a socket `Error`, or a user throw. */
  readonly cause: unknown;
  /** R2: set ONLY when this infra failure arose while rolling back a domain `err(E)` whose
   *  ROLLBACK then failed — the swallowed domain error, preserved for triage. Distinct from
   *  `cause` (never the same object). Typed `unknown` (the union is not generic over E). */
  readonly lostDomainError?: unknown;
}

export type DrizzleTxError =
  // assembly / pool — unchanged, no structured triad:
  | { readonly kind: 'PoolConnectionTimeout'; readonly timeoutMs: number | undefined }
  | { readonly kind: 'HostNotInitialized'; readonly connectionName: string | undefined }
  | { readonly kind: 'NotPoolBacked' }
  // transaction-body failures — all carry TxFailureFields:
  | ({ readonly kind: 'SerializationFailure' } & TxFailureFields)  // 40001         → retryable
  | ({ readonly kind: 'DeadlockDetected'     } & TxFailureFields)  // 40P01         → retryable
  | ({ readonly kind: 'ConnectionLost'       } & TxFailureFields)  // class 08 / 57P0x / socket → infra ≠ bug
  | ({ readonly kind: 'TransactionAborted'   } & TxFailureFields); // residual catch-all
```

Constructor helpers mirror the existing ones (`serializationFailure(f)`, `deadlockDetected(f)`, `connectionLost(f)`, and `transactionAborted(f)` now takes `TxFailureFields`, not a bare `cause`).

- **Named variants are driver-agnostic *concepts*** (serialization conflict, deadlock, connection loss). Only the **code→concept mapping is Postgres-specific** (§3). `sqlState` is the standard SQLSTATE term, not pg's `.code`, so the field name survives a second SQL driver.
- **No `retryable: boolean` field.** Retry *policy* is the future retry feature's call; the variant + `sqlState` carry enough to decide. A boolean would bake one policy into the error.
- **No separate `CommitFailure` variant.** A serialization error surfacing at COMMIT is still `SerializationFailure` — that is exactly what carrying `sqlState` buys. The *phase* (statement vs commit vs savepoint-release) is not modeled; the SQLSTATE is what callers act on.
- **`PoolConnectionTimeout` stays separate** — it's recognized *before* classification (`isPoolTimeoutError`) and has no SQLSTATE.

### 2. R2 — infra-trumps-domain, but preserve the swallowed `E` in a distinct field

The contract: when a domain `err(E)`'s ROLLBACK *itself* fails, the **infra failure wins the `Result` error channel** (the caller gets the `DrizzleTxError`, not `E`), because the transaction's state is now unknown and that is the more urgent truth. But the domain `E` is **not discarded** — it rides in `lostDomainError`, never overloading `cause`.

Mechanism (the manager stashes the in-flight domain error so the boundary can recover it):

```ts
// in #newTransaction / #nested:
let inFlight: { error: E } | undefined;
const value = await this.#adapter.wrapWithTransaction(options, (tx) =>
  this.#ctx.run(tx, async () => {
    const r = await work();
    if (!r.ok) inFlight = { error: r.error };  // record BEFORE toThrowable throws
    return toThrowable(r);                       // err → throw RollbackSignal(r.error)
  }),
);
// catch (e) → classifyRollback<E>(e, inFlight)
```

`classifyRollback(e, inFlight)` then:
- `e instanceof RollbackSignal` → `err(payload)` — the normal path (ROLLBACK succeeded, `E` returned faithfully); `inFlight` unused.
- otherwise → classify `e` into a `DrizzleTxError`; **if `inFlight` is set**, attach `lostDomainError = inFlight.error` — the double-fault case.

This keeps ADR-0006's immutable **store** intact (the stash is a boundary-local closure variable, not ALS state) and does not overload `cause`.

*Accepted minor edge:* only a Result-returned `err(E)` is preserved. An *unexpected throw* from `work()` that is then shadowed by a failing ROLLBACK is lost (rare double-fault; the throw was already a bug). Documented, not fixed here.

### 3. Classification — structural, in core, Postgres mapping; hoist to the adapter on multi-driver

A pure function reads the caught value with **no `pg` import**, in this precedence:

1. **Socket / client-side connection loss → `ConnectionLost`** (checked *first*, so `sqlState` stays `undefined`):
   - a libuv socket error — `.syscall` present, or `.code ∈ {ECONNRESET, EPIPE, ETIMEDOUT, ENOTFOUND, ECONNREFUSED}`; **or**
   - pg's code-less teardown errors — `.message` contains `"Connection terminated"` / `"Connection terminated unexpectedly"` with no SQLSTATE.
   - (Checked before SQLSTATE mapping so a libuv `EPIPE`, which *looks* like a 5-char SQLSTATE, is never mistaken for one.)
2. **SQLSTATE present** (`err.code` is a `DatabaseError` SQLSTATE — a 5-char string, recognized structurally by an accompanying string `.severity`/`.routine`, not by `instanceof`) → map by the **Postgres table below**; unmapped codes → `TransactionAborted` with `sqlState` still populated.
3. **Anything else** (a plain user throw, no `.code`) → `TransactionAborted`, `sqlState: undefined`, `message` from `.message`.

Postgres code→concept table (source-confirmed, PostgreSQL Appendix A):

| SQLSTATE | Condition | → variant |
|---|---|---|
| `40001` | `serialization_failure` | **SerializationFailure** |
| `40P01` | `deadlock_detected` | **DeadlockDetected** |
| Class `08` (`08000/08001/08003/08004/08006/08007/08P01`) | `connection_exception` | **ConnectionLost** |
| `57P01/57P02/57P03/57P04/57P05` | admin/crash shutdown, cannot-connect-now, database-dropped, idle-session-timeout | **ConnectionLost** |
| everything else (incl. `57014 query_canceled`, `57000`) | — | **TransactionAborted** (with `sqlState`) |

- **Classification stays in core (`rollback-boundary.ts`) for now** — the same structural discipline as `isPoolTimeoutError`. This is a *documented, intentional* coupling to Postgres SQLSTATE semantics, not a leak.
- **Hoist the code→concept mapping to the adapter seam when multi-driver (G3) lands** — a second driver brings its own SQLSTATE-equivalent, so the mapping becomes per-adapter and the manager consumes the already-classified variant. Loose coupling; documented; **not a blocker** for this ADR.

### R1 — COMMIT-may-err contract (documented + tested)

Document on `withTransaction`/`begin`: **a work fn returning `ok(value)` can still resolve to `err(...)`** — COMMIT runs inside the transaction boundary (deferred constraints, serialization-at-commit under SERIALIZABLE), and such a failure surfaces as the classified variant (e.g. `SerializationFailure` at commit). Add a real-Postgres **deferred-constraint COMMIT-failure** integration test (execution; part of the T2 failure-scenario story gated on the #28 failure-injecting adapter, but the deferred-constraint case is a real-DB test needing no injection).

## Consequences

- **Breaking, but compile-caught.** Adding `SerializationFailure`/`DeadlockDetected`/`ConnectionLost` and widening `TransactionAborted`'s shape breaks every exhaustive `switch`/`matchError` over `DrizzleTxError` — by design (ADR-0003 exhaustiveness). Known sites to update: the `errors.test-d.ts` exhaustiveness fixtures, any `matchError` consumer. The `@drizzle-tx/nestjs` re-export of `matchError` is unaffected structurally; consumer maps that match on it must add cases.
- **CONTEXT.md's `DrizzleTxError` entry updates in lockstep with the implementation PR** (it currently lists the four old variants) — not edited now, to avoid documenting an unshipped shape ahead of code (plan-don't-do).
- **Enables** retry classification (`kind`/`sqlState`), OTel error attributes (`message`/`sqlState`), and resilience triage (`ConnectionLost` ≠ code bug) — without importing `pg`.
- **`lostDomainError`** gives operators the swallowed domain error on the rare rollback-double-fault, without overloading `cause` or making the union generic.
- **Implementation is execution-backlog**, gated by the boundary-shape lock this ADR provides; the failure-injection **test story** is gated on the #28 `/testing` adapter (the deferred-constraint COMMIT test needs only real Postgres).

## Rejected alternatives

- **Structured `cause` only, no named variants** (put SQLSTATE in a field, keep one `TransactionAborted`). Rejected: retry/triage callers would re-implement the code→concept mapping at every call site; the named variant *is* the shared classification, matched exhaustively.
- **`retryable: boolean` field.** Rejected: bakes retry policy into the error; policy belongs to the future retry feature. Variant + `sqlState` are sufficient and policy-neutral.
- **A `CommitFailure` variant.** Rejected: the actionable fact is the SQLSTATE, not the phase; a commit-time `40001` is a `SerializationFailure` like any other. Modeling phase would multiply variants without payoff.
- **Overload `cause` to hold both infra error and the swallowed `E`** (R2). Rejected by the ticket and here: ambiguous (is `cause` the infra failure or the domain error?); the distinct `lostDomainError` field is unambiguous.
- **Import `pg` / depend on `DatabaseError instanceof`.** Rejected: violates core's zero-`pg` stance and breaks across duplicated `pg` instances (the same reason `isPoolBacked`/`isPoolTimeoutError` are structural). Read `.code`/`.severity`/markers structurally.
- **Classify in the adapter now.** Rejected *for now*: premature with a single driver; core owns the Postgres mapping until G3/multi-driver, then it hoists. Recorded as the migration path, not a current split.

## Evidence

- **PostgreSQL SQLSTATE** (Appendix A): `40001 serialization_failure`, `40P01 deadlock_detected`; Class 08 connection-exception `08000/08001/08003/08004/08006/08007/08P01`; Class 57 `57P01 admin_shutdown`/`57P02 crash_shutdown`/`57P03 cannot_connect_now`/`57P04 database_dropped`/`57P05 idle_session_timeout` (vs `57014 query_canceled`, not connection loss). <https://www.postgresql.org/docs/current/errcodes-appendix.html>
- **node-postgres** — a query error is a `DatabaseError extends Error` carrying `.code` (5-char SQLSTATE `string | undefined`) plus `.severity`/`.routine`/…; `.code` attaches identically on COMMIT and SAVEPOINT/ROLLBACK failures (single ErrorResponse→`DatabaseError` parse path). Client-side connection loss instead throws a **code-less** `new Error('Connection terminated unexpectedly'|'Connection terminated')`, or a raw libuv error (`ECONNRESET`/`EPIPE`/…). pg-protocol `messages.ts`, pg `client.js`, issue #3107.
- **drizzle-orm `node-postgres/session`** — top-level `transaction()`: `begin` → try{ cb; `commit` } → catch{ `rollback`; `throw error` }; the `rollback` is **not** in its own try/catch, so a failing ROLLBACK shadows the original callback error (no aggregation, no `.cause`). Savepoint path (`rollback to savepoint`) identical. Verified against the pinned `drizzle-orm@1.0.0-rc.4` in this repo's `node_modules` (matches `main`). Grounds R2's necessity and the R1 COMMIT-inside-try fact.
