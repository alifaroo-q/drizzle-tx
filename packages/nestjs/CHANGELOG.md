# @drizzle-tx/nestjs

## 0.2.0

### Minor Changes

- aa7a715: `TransactionHost` tracks the core two-primitive + error-model work.

  - `begin()` accepts `BeginOptions` (incl. `disposeTimeoutMs`), forwarded to core —
    full parity with the scope leak-backstop.
  - `withTransaction` is now bound from core's exported `WithTransaction<TClient>`
    contract instead of a hand-redeclared overload set + cast, so the
    `REQUIRES_NEW` `Independent` overloads are preserved and can't drift from core.
  - Re-exports `settle` and `Independent` (needed to consume a `REQUIRES_NEW`
    outcome); `assertNever` is no longer re-exported (use `matchError`).

  BREAKING (pre-1.0 minor): `TransactionHost.isActive()` is renamed to
  `isTransactionActive()`. Update call sites accordingly.

### Patch Changes

- Updated dependencies [aa7a715]
- Updated dependencies [aa7a715]
- Updated dependencies [aa7a715]
- Updated dependencies [aa7a715]
- Updated dependencies [aa7a715]
  - @drizzle-tx/core@0.3.0

## 0.1.2

### Patch Changes

- 6136c82: Add `createDrizzleTx({ drizzle })` — the single non-DI canonical assembly path returning `{ db, withTransaction, begin, isActive, manager }`. Constructing against a non-interactive driver (Neon HTTP) now fails fast with a typed `UnsupportedDriverError` at assembly instead of a mysterious runtime throw. The NestJS module now sources its `TransactionManager` from `createDrizzleTx`, so defaults can't drift between surfaces (behavior-preserving).
- Updated dependencies [6136c82]
  - @drizzle-tx/core@0.2.0

## 0.1.1

### Patch Changes

- Add `repository`, `homepage`, and `bugs` fields to the published package manifests. npm provenance (generated on the CI OIDC publish) requires `repository.url` in `package.json` to match the building repository, so publishes without it fail with `E422 - Failed to validate repository information`.
- Updated dependencies
  - @drizzle-tx/core@0.1.1

## 0.1.0

### Minor Changes

- 0e24451: Require Node.js >= 22.13. Node 20 reached end-of-life (April 2026) and the pinned pnpm toolchain requires >= 22.13, so it is dropped from the support matrix.
- 73c218c: initial v0.1.0 — framework-agnostic AsyncLocalStorage Drizzle transaction engine (`@drizzle-tx/core`) and NestJS 11 adapter (`@drizzle-tx/nestjs`) with an explicit-Result API, REQUIRED/REQUIRES_NEW/NESTED propagation, and a tx-aware injectable client.
- f19202b: Add `@drizzle-tx/nestjs/testing`, providing a no-op transaction-manager override for testing real `@Transactional` services without Postgres, including observable transaction-boundary logs.

### Patch Changes

- Updated dependencies [0e24451]
- Updated dependencies [73c218c]
  - @drizzle-tx/core@0.1.0
