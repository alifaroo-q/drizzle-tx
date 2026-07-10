# @drizzle-tx/nestjs

## 0.1.0

### Minor Changes

- 0e24451: Require Node.js >= 22.13. Node 20 reached end-of-life (April 2026) and the pinned pnpm toolchain requires >= 22.13, so it is dropped from the support matrix.
- 73c218c: initial v0.1.0 — framework-agnostic AsyncLocalStorage Drizzle transaction engine (`@drizzle-tx/core`) and NestJS 11 adapter (`@drizzle-tx/nestjs`) with an explicit-Result API, REQUIRED/REQUIRES_NEW/NESTED propagation, and a tx-aware injectable client.
- f19202b: Add `@drizzle-tx/nestjs/testing`, providing a no-op transaction-manager override for testing real `@Transactional` services without Postgres, including observable transaction-boundary logs.

### Patch Changes

- Updated dependencies [0e24451]
- Updated dependencies [73c218c]
  - @drizzle-tx/core@0.1.0
