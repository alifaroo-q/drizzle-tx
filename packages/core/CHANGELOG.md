# @drizzle-tx/core

## 0.3.0

### Minor Changes

- aa7a715: Deliberate two-tier export surface (#32).

  The barrel is now an enumerated Tier A (app-developer) / Tier B (adapter-author)
  surface. New Tier B exports for adapter authors: the `WithTransaction<TClient>`
  overload contract (incl. the `REQUIRES_NEW` `Independent` brand) and the
  `TxFailureFields` factory parameter type.

  BREAKING (pre-1.0 minor): `assertNever` is no longer exported from
  `@drizzle-tx/core` — it was an internal helper. For `DrizzleTxError`
  exhaustiveness use `matchError(err, handlers)` (a complete handler map is
  compile-enforced), or a local `switch` in your own code.

- aa7a715: Add `FaultInjectingDrizzleAdapter` and pg error-shape helpers to
  `@drizzle-tx/core/testing` (#28).

  The adapter injects faults at any transaction phase (`begin`/`commit`/`rollback`
  and the savepoint phases), sticky or one-shot (`failOn`/`failOnce`, or a
  constructor `failAt` map), and records a boundary log — so you can exercise the
  rollback-boundary classification (serialization/deadlock/connection-lost, R2
  shadowing, nested savepoints) without a database. Ships with `fakePgError`,
  `socketError`, and `pgSerializationFailure`/`pgDeadlock`/`pgAdminShutdown`
  helpers that carry the exact structural markers `classifyCaught` reads.

  Additive; this surface is stable but test-only (see STABILITY.md).

- aa7a715: Structured transaction-failure error model (ADR-0012).

  `DrizzleTxError` is now a richer discriminated union. Transaction-body failures
  (`SerializationFailure`, `DeadlockDetected`, `ConnectionLost`, `TransactionAborted`)
  carry `TxFailureFields` — `{ message, sqlState, cause }` — and are classified
  structurally from the pg SQLSTATE / socket markers, walking Drizzle's
  `DrizzleQueryError` `.cause` chain so a wrapped driver error is still classified
  by the underlying pg code. A rollback double-fault preserves the swallowed domain
  error as `lostDomainError` (ADR-0012 §2). A `COMMIT` that fails (deferred
  constraint / serialization at commit) now surfaces as the classified variant even
  when the work returned `ok(...)` (ADR-0012 §1, R1).

  BREAKING (pre-1.0 minor): consumers that matched on the previous flat
  `DrizzleTxError` shape must switch to the new variants. Use `matchError(err, { ... })`
  for an exhaustive, compile-checked handler map (e.g. mapping to an HTTP status).

- aa7a715: Two-primitive split: `Independent` outcomes for `REQUIRES_NEW` + opt-in scope
  leak backstop (ADR-0014, #31).

  - `REQUIRES_NEW` now returns an `Independent<T, E>` — a settled outcome on its OWN
    connection that you inspect (`.ok`/`.value`/`.error`) rather than `return` from
    the outer work. `return inner` is a compile error; `return settle(inner)`
    consciously propagates the inner outcome as the outer's. New exports: the
    `Independent<T,E>` type and `settle()` (runtime identity, zero cost).
  - `begin()` scopes gain an opt-in `disposeTimeoutMs` leak backstop (per-call or a
    `TransactionManager`/`createDrizzleTx` default). Default OFF; when set, a scope
    that is never disposed is reclaimed — forced rollback + release + a loud warn.
    Prefer `await using` so disposal is guaranteed and the backstop never fires.

  BREAKING (pre-1.0 minor): the `REQUIRES_NEW` overloads now return
  `Independent<T, E | DrizzleTxError>` instead of a plain `Result`. Callers that
  `return`ed a `REQUIRES_NEW` result directly must wrap it in `settle(...)` (or
  `ok(...)` to commit the outer regardless).

### Patch Changes

- aa7a715: Fixes:

  - `FaultInjectingDrizzleAdapter.failOn`/`failOnce` now throw the error you pass
    verbatim. Previously they routed through the `{ error, times }` structural
    probe, so an error object that happened to carry an `.error` key was silently
    reinterpreted as a config and its inner `.error` thrown instead.
  - `begin({ disposeTimeoutMs })` now treats a non-positive value (`0` / negative)
    as OFF instead of arming an immediate rollback of still-live work, and
    `disposeTimeoutMs` no longer leaks into the SQL adapter's `BEGIN` config.
  - The scope leak-backstop no longer emits a misleading "not disposed" warning
    when the transaction already self-terminated (e.g. a connection drop) before
    dispose.

## 0.2.0

### Minor Changes

- 6136c82: Add `createDrizzleTx({ drizzle })` — the single non-DI canonical assembly path returning `{ db, withTransaction, begin, isActive, manager }`. Constructing against a non-interactive driver (Neon HTTP) now fails fast with a typed `UnsupportedDriverError` at assembly instead of a mysterious runtime throw. The NestJS module now sources its `TransactionManager` from `createDrizzleTx`, so defaults can't drift between surfaces (behavior-preserving).

## 0.1.1

### Patch Changes

- Add `repository`, `homepage`, and `bugs` fields to the published package manifests. npm provenance (generated on the CI OIDC publish) requires `repository.url` in `package.json` to match the building repository, so publishes without it fail with `E422 - Failed to validate repository information`.

## 0.1.0

### Minor Changes

- 0e24451: Require Node.js >= 22.13. Node 20 reached end-of-life (April 2026) and the pinned pnpm toolchain requires >= 22.13, so it is dropped from the support matrix.
- 73c218c: initial v0.1.0 — framework-agnostic AsyncLocalStorage Drizzle transaction engine (`@drizzle-tx/core`) and NestJS 11 adapter (`@drizzle-tx/nestjs`) with an explicit-Result API, REQUIRED/REQUIRES_NEW/NESTED propagation, and a tx-aware injectable client.
