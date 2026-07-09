# Functional core / imperative shell split of `@drizzle-tx/core`

The core engine is organized as a **functional core** (pure decision logic) wrapped by a **thin imperative shell** (the effects). Pure modules produce plain-data descriptions of what to do; the shell interprets them and performs the I/O. Concretely: `propagation-plan.ts` (pure — `planTransaction` returns a `TxPlan`; `normalizeArgs`) and `rollback-boundary.ts` (pure — `toThrowable` / `classifyRollback` translate between the `Result` model and Drizzle's throw-to-rollback path) are the core; `transaction-context.ts` (the `AsyncLocalStorage` wrapper) and `transaction-scope.ts` (the `await using` gate bridge) are effect modules; `transaction-manager.ts` is the coordinator that snapshots ALS into a value, asks the core what to do, and interprets the result.

## Why

The engine's logic was concentrated in one ~290-line `transaction-manager.ts` that tangled pure decisions (the propagation switch, argument normalization, the `throw`↔`Result` translation) with effects (ALS mutation, adapter calls, logging). The decisions could only be exercised through a full fake-adapter + ALS round-trip, and the engine's central mutable state — the ALS store's `client` field, reassigned in place via a `setClient` callback threaded through the adapter interface — was the subtlest thing in the codebase. Separating "decide" from "do" makes the decisions pure, immutable, and trivially unit-testable (no Docker, no ALS), while the genuinely effectful parts stay small and are covered by the real-Postgres integration suite. This is a maintainability/testability investment; it changes no observable behavior (see below).

## Key decisions

- **The propagation decision is a pure function returning a `TxPlan` value** (`join` / `new-root` / `nested` / `reject`). The shell interprets the plan. `TxPlan` is the documented seam for future propagation modes — additive and compile-checked via `assertNever` (a missing case fails to compile; enforced by `propagation-plan.test-d.ts`).
- **The pure core never calls `getStore()`.** The shell reads ALS once, exposes it as `isTransactionActive()` / `getTransactionClient()`, and passes an `active: boolean` snapshot into `planTransaction`. `run()`-only is preserved; `enterWith` remains forbidden (ADR-0001).
- **One deep `TransactionAdapter` port, not many shallow ones.** All Drizzle/`pg` specifics (rc.4 construction, structural `isPoolBacked`, CJS/ESM `instanceof`) stay hidden behind the single adapter. The `PoolTimeoutError` structural match lives in `rollback-boundary.ts` so core still never imports `pg`.
- **The error model is unchanged.** The in-house `Result` + exhaustive `DrizzleTxError` (ADR-0003) is kept as-is; no effect system (Effect-TS) or Result library (neverthrow/fp-ts) was adopted — they would impose a runtime/DI or a dependency on every consumer of a *library's* public API.

### Flagged decisions (behavior-neutral structural changes accepted with this ADR)

- **A — The adapter port drops `setClient`.** `wrapWithTransaction(options, work)` / `wrapWithNestedTransaction(parent, work)` now hand the tx/savepoint client *to* `work`. The manager enters `TransactionContext.run(tx, …)` **inside** the adapter callback, so the ALS store is constructed immutable from the real client — the in-place `client` mutation is gone. Blast radius was internal: only core's `DrizzleAdapter` and core's fake test adapters; `@drizzle-tx/nestjs` never implements the port (it constructs core's `DrizzleAdapter`) and compiled unchanged.
- **B — The ALS store is `{ readonly client }`; presence in the store means "active".** The redundant `active: boolean` field is removed, so it can no longer disagree with store presence.
- **C — "Options are ignored on join/nested" is a pure decision.** `planTransaction` carries `ignoredOptions` (only when non-empty, preserving the original `Object.keys(options).length > 0` predicate); the shell performs the `logger.warn`. Same observable warning, now pure-testable.

## Considered / rejected

- **Extract private methods without extracting purity**: the original already used private methods, but they closed over `#als`/`#adapter`/`#logger`, so they were not independently testable and the mutation still leaked through the port. Rejected — it does not move the testability needle.
- **Shatter the adapter into `Connector` + `SavepointManager` + `Committer` ports**: over-application of hexagonal that breeds shallow pass-through interfaces (Ousterhout). Rejected in favor of one deep port.
- **Keep `setClient` for a smaller diff**: retaining the mutation callback would preserve the exact footgun this refactor exists to remove. Rejected; `v2`-level freedom made the port change acceptable.

## Consequences

- New pure unit suites (`propagation-plan.test.ts`, `rollback-boundary.test.ts`) and a `transaction-context.test.ts` boundary suite run with no DB; the unchanged `core-integration` suite (propagation, scope, drizzle-adapter) is the behavioral oracle proving no behavior changed.
- `transaction-manager.ts` is a ~140-line coordinator (down from ~290): it no longer contains the propagation switch, the `throw`↔`Result` translation, the `AsyncLocalStorage` field, the in-place mutation, or the `begin()` gate machinery.
- External implementers of `TransactionAdapter` (none known outside core) must adopt the callback-style port — a breaking, compile-caught change.
