# @drizzle-tx/core

## 0.1.1

### Patch Changes

- Add `repository`, `homepage`, and `bugs` fields to the published package manifests. npm provenance (generated on the CI OIDC publish) requires `repository.url` in `package.json` to match the building repository, so publishes without it fail with `E422 - Failed to validate repository information`.

## 0.1.0

### Minor Changes

- 0e24451: Require Node.js >= 22.13. Node 20 reached end-of-life (April 2026) and the pinned pnpm toolchain requires >= 22.13, so it is dropped from the support matrix.
- 73c218c: initial v0.1.0 — framework-agnostic AsyncLocalStorage Drizzle transaction engine (`@drizzle-tx/core`) and NestJS 11 adapter (`@drizzle-tx/nestjs`) with an explicit-Result API, REQUIRED/REQUIRES_NEW/NESTED propagation, and a tx-aware injectable client.
