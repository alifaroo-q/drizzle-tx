# Framework-agnostic core on raw AsyncLocalStorage (not built on nestjs-cls)

The transaction engine lives in a standalone `@drizzle-tx/core` package built directly on Node's `AsyncLocalStorage` (`run()`), with a NestJS adapter (`@drizzle-tx/nestjs`) layered on top. We deliberately did **not** build on `@nestjs-cls/transactional` + its Drizzle adapter, even though that is the mature, battle-tested option that would have been faster to ship.

## Why

The reason this package exists is to support **multiple web frameworks** (NestJS first, then Hono/Express/Fastify). `nestjs-cls` hard-depends on `@nestjs/core` and the Nest module system — it is structurally NestJS-only and cannot back a Hono/Express adapter. Building on it would have permanently blocked the core goal. A raw-ALS core keeps the engine free of any web-framework dependency so adapters are additive.

## Considered options

- **Build on `@nestjs-cls/transactional`** — fastest, inherits a proven engine + all 7 propagation modes. Rejected: NestJS-only; makes our package mere sugar; blocks multi-framework.
- **Standalone on `nestjs-cls` core (`ClsService`)** — reuses ALS-in-Nest plumbing but still Nest-coupled. Rejected: same coupling, no gain over raw ALS.
- **Standalone on raw `AsyncLocalStorage`** — chosen. We still *learn from* nestjs-cls's design (the `Propagation` semantics, the `wrapWithTransaction`/`wrapWithNestedTransaction`/`getFallbackInstance` adapter seam, and the static-registry method-decorator pattern) without a runtime dependency on it.

## Consequences

- We re-implement (and must test) the propagation state machine ourselves; v1 scopes this to REQUIRED / REQUIRES_NEW / NESTED to keep that surface small.
- `@drizzle-tx/core` must have **zero** runtime dependency on `nestjs-cls` or `@nestjs/*` — enforced as an acceptance criterion.
- Use `run()`, never `enterWith()`, to avoid context leakage. **Consequence ([ADR-0014](0014-two-primitive-split-and-scope-robustness.md)):** because ALS needs a callback and `enterWith` is forbidden, the `await using` scope cannot set ALS — hence the deliberate two-primitive split (callback `withTransaction` = implicit propagation; `begin()`/scope = explicit `scope.tx`, no auto-join). No propagation-preserving scope is built.
