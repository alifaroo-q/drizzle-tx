# An observable no-op adapter ships from `@drizzle-tx/core/testing`

`@drizzle-tx/core` ships a second `TransactionAdapter` implementation — `NoOpDrizzleAdapter` — from a dedicated **`@drizzle-tx/core/testing`** subpath. It runs transactional work against a single caller-supplied client (a mock/stub *or* a real test DB) **without** issuing any `BEGIN` / `COMMIT` / `SAVEPOINT`, and it **records the boundaries it enters** so tests can assert propagation behavior without a database. `@drizzle-tx/nestjs` ships a matching `@drizzle-tx/nestjs/testing` helper that produces the DI override.

This piggybacks on prior art: `nestjs-cls` ships a `NoOpTransactionalAdapter` "for testing purposes or making sure that the `TransactionHost` is wired up correctly." Ours goes one step further by being *observable*.

## Why

Without a test seam, the only way to exercise a `@Transactional` service is a real-Postgres round-trip (Docker + Testcontainers). That is right for the integration suite but too heavy for unit-testing business logic and for asserting that propagation is wired correctly. A no-op adapter lets a consumer run the exact production `TransactionManager` / `TransactionHost` / decorator path against a mock client, in-process, with no DB.

## Key decisions

- **Isolated `/testing` subpath, not the main entry.** A class that logs "transactions are disabled" has no place in the production API surface. The subpath keeps it out of the main entry and out of `@drizzle-tx/nestjs`'s production import graph (the Nest helper is likewise a `@drizzle-tx/nestjs/testing` subpath, not a `Module.forTest()` on the main surface). Cost accepted: a second build entry + `exports` map + `attw`/`publint --strict` coverage for the new subpath.
- **One client, no SQL.** `getBaseClient()`, `wrapWithTransaction`, and `wrapWithNestedTransaction` all resolve `work` against the single supplied client. There is no real transaction, so there is no isolation, no durability, and no actual rollback of data.
- **Rollback is a faithful `Result`, not a data effect.** Core's `err(...)` → throw → `classifyRollback` path is unchanged: the no-op lets the rollback signal propagate, so the manager returns the `err`. The mock client is simply never mutated. Tests assert on the returned `Result`.
- **`supportsIndependentTransactions: true`.** So `REQUIRES_NEW` inside a test runs the body rather than short-circuiting to `err(NotPoolBacked)`. There is no real pool, so the ADR-0002 deadlock caveat does not apply.
- **Observable boundary log.** The adapter records an ordered list of the boundaries it enters and each outcome — `{ kind: 'new-root' | 'nested'; outcome: 'commit' | 'rollback' }`. Outcome is derived exactly where the real adapter derives it: the `work` callback resolving means `commit`, throwing means `rollback`. This lets a test assert propagation precisely (e.g. "the outer committed, the inner savepoint rolled back") without a DB.
- **`join` is deliberately NOT recorded.** A `REQUIRED`/`NESTED` call that joins an existing transaction never reaches the adapter — `transaction-manager.ts` returns `work()` directly for the `join` plan. So the boundary log contains only genuine boundaries, which is accurate, not a gap.
- **Warns once, suppressible.** Construction emits a single "transactions are disabled" warning via the injected `TxLogger`, silenced with `{ quiet: true }`. (`nestjs-cls` warns on *every* `wrapWithTransaction` call, which is noisy in a test suite; once-per-instance is enough.)

## The trade-off (why "observable" over "minimal")

The minimal alternative — run work, preserve `Result`, expose nothing — is smaller and can't drift. Observability was chosen anyway because asserting *which* propagation boundary was taken is the single thing a `Result`-only assertion cannot express, and it is exactly what "is `@Transactional` wired correctly?" tests want. The accepted risk is that the boundary log becomes a **second source of truth** about propagation that must stay consistent with the real adapter's behavior. This is mitigated by keeping the log a passive record of adapter-method entry (it asserts nothing about *how* a real DB would behave) and by driving both adapters through the same `planTransaction` core (ADR-0006), so the *decision* of which boundary to enter is shared, not reimplemented.

## Rejected alternatives

- **Minimal no-op (assert on `Result` only).** Rejected: cannot verify propagation wiring, the primary reason to reach for a test adapter over a plain mock.
- **Ship from the main entry** (as `nestjs-cls` does). Rejected: puts a test-only, "transactions disabled" class in the production surface.
- **`DrizzleTransactionModule.forTest()` on the module's main surface.** Rejected: pulls `core/testing` into the nestjs package's production import graph, defeating the isolation.
