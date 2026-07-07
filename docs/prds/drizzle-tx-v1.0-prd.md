# @drizzle-tx — Product Requirements Document (PRD)

> A framework-agnostic Drizzle ORM transaction manager using Node.js `AsyncLocalStorage`, with a first-class NestJS adapter. Spring-`@Transactional`-style implicit transaction propagation — no prop-drilling the `tx` client.

## Requirements Description

### Background

- **Business Problem**: In Drizzle ORM, transactions are callback-scoped (`db.transaction(async (tx) => …)`). The `tx` client must be threaded explicitly through every service and repository that participates in the transaction ("prop-drilling"). This couples business logic to transaction plumbing, makes composing multi-repository units of work awkward, and has no notion of propagation (join-or-create, run-in-a-new-transaction, savepoints). If unsolved, teams keep hand-rolling ad-hoc `tx`-passing per project — repetitive, error-prone, and easy to get wrong (a repository silently using the base `db` instead of the active `tx` escapes the transaction and breaks atomicity). Drizzle core has repeatedly declined to ship implicit propagation (drizzle-orm issues #543, #1473), leaving the gap to third parties.
- **Target Users**:
  - The author (farooq) and their team, who will use this in **production NestJS work projects** backed by Postgres.
  - NestJS + Drizzle developers who want a Spring-`@Transactional` developer experience.
  - (Forward-looking, not v1) developers on **other Node web frameworks** — Hono, Express, Fastify — who want the same implicit-transaction ergonomics that today only exist for NestJS via `@nestjs-cls/transactional`.
- **Value Proposition**: Annotate a method with `@Transactional()` (or wrap a block with `withTransaction()`); every Drizzle query in the resulting call tree implicitly joins one transaction and commits/rolls back atomically. Repositories inject **one** database handle that transparently becomes the active transaction when inside one, and the base connection otherwise. A **framework-agnostic core** means the same engine can back adapters for many frameworks — the differentiator over the NestJS-only `@nestjs-cls/transactional`.

### Feature Overview

- **Core Features (v1)**:
  1. **Framework-agnostic transaction engine** (`@drizzle-tx/core`) built on raw `AsyncLocalStorage` (`run()`), with a Drizzle adapter seam and a tx-aware client proxy.
  2. **Three propagation modes**: `REQUIRED` (default), `REQUIRES_NEW`, `NESTED` (Postgres savepoints).
  3. **Isolation / access-mode options** (`isolationLevel`, `accessMode`, `deferrable`) passed through to Drizzle **only where a new top-level transaction actually begins** (`REQUIRES_NEW` always; `REQUIRED` when it *creates* the transaction). When `REQUIRED` *joins* an existing transaction, or on `NESTED` (a savepoint), these options are **stripped and a warning is logged** — Postgres fixes isolation at transaction start, so applying them to a join/savepoint is meaningless and can even error (`SET TRANSACTION ISOLATION LEVEL must be called before any query`).
  4. **NestJS 11 adapter** (`@drizzle-tx/nestjs`): `DrizzleTransactionModule.forRoot()/forRootAsync()`, a `@Transactional()` method decorator, a `TransactionHost` service (`tx`, `withTransaction()`, `isTransactionActive()`), and a **tx-aware injectable client** (inject one `db` that auto-joins).
  5. **Real-database test suite** proving commit/rollback/savepoint/isolation behavior against a live Postgres.
- **Feature Boundaries (explicitly OUT of v1)**:
  - Propagation modes `SUPPORTS`, `NOT_SUPPORTED`, `MANDATORY`, `NEVER` — engine leaves a clean seam; not shipped or tested in v1.
  - Non-Postgres drivers (MySQL / SQLite / Neon-HTTP / others) — `pg` (node-postgres) only.
  - Post-transaction **lifecycle hooks** (`runOnTransactionCommit/Rollback/Complete`) — seam left, not implemented.
  - **Multiple / named connections** — single default connection; tokens structured to add named connections additively later.
  - **Hono / Express / Fastify adapters** — monorepo is structured for them; not built in v1.
  - **Synchronous-driver transaction path** (`better-sqlite3` et al.) — the adapter is **async-only** in v1 (Postgres is always async). The adapter interface leaves a seam so a `sync` adapter/`transactionMode` can be *added* with SQLite support; we deliberately do **not** ship an untested sync branch now.
  - Any dependency on `nestjs-cls` at runtime (studied as prior art only).
- **User Scenarios**:
  1. *Atomic money transfer*: `UserService.transferFunds()` is `@Transactional()`; it calls `repo.decrement(sender)` then `repo.increment(receiver)`. Both run in one transaction; if the second throws, the first rolls back.
  2. *Independent audit log*: an audit write annotated `@Transactional(Propagation.REQUIRES_NEW)` commits on its own connection even if the outer business transaction later rolls back.
  3. *Partial rollback*: a `NESTED` sub-operation fails and rolls back to its savepoint while the surrounding transaction continues and commits.
  4. *Imperative use*: code that can't use a decorator calls `txHost.withTransaction(async () => { … })`.

### Detailed Requirements

- **Input/Output** (all fallible operations return `Result`, never throw — see Error Handling):
  - **Core** `TransactionManager<TTx>(adapter, options?)`:
    - `getTransactionClient(): TTx` — returns the active tx or the fallback base client (total, cannot fail).
    - `isTransactionActive(): boolean`.
    - `withTransaction(work)` / `withTransaction(propagation, work)` / `withTransaction(propagation, options, work)` / `withTransaction(options, work)` where `work: () => Promise<Result<T, E>>` → `Promise<Result<T, E | DrizzleTxError>>`.
  - **Core** `DrizzleAdapter({ drizzle, transactionMode?: 'auto'|'sync'|'async', defaultTxOptions? })` implementing `wrapWithTransaction`, `wrapWithNestedTransaction`, `getFallbackInstance`.
  - **Core** `createTransactionalClient<TTx>(manager): TTx` — a transparent Proxy over Drizzle resolving to the active tx per property access (supports both the query builder and `db.query.*`).
  - **NestJS** `@Transactional(propagation?, options?)` — wraps a method so its body runs via the engine.
  - **NestJS** `DrizzleTransactionModule.forRoot({ drizzle, defaultTxOptions?, transactionMode? })` and `.forRootAsync({ useFactory, inject, imports })`.
  - **NestJS** injectable `TransactionHost` and token/decorator to inject the tx-aware client.
- **User Interaction (flow)**: register module → inject tx-aware `db` in repositories → put `@Transactional()` on the service orchestration method (or call `withTransaction()`) → throw to roll back, return to commit.
- **Data Requirements**:
  - Engine store (kept intentionally small and statically-shaped to avoid V8 shape churn / GC pressure): `{ tx: TTx | undefined; depth: number }`.
  - No persistent data model owned by the library; it operates on the consumer's Drizzle schema. The **test** schema defines two related tables (e.g. `users` and `accounts`/`posts`) via Drizzle `1.0` `defineRelations`, exercised through both the insert/select query builder and `db.query.*`.
  - **Test isolation — database-per-worker.** Integration tests run **fully parallel**; `globalSetup` starts one `postgres:17-alpine` container, and each Vitest worker creates + migrates its **own** database keyed by `VITEST_POOL_ID` (pool `forks`). This is required because behavior assertions read global tables (`findMany`, "row absent after rollback"), which would race across files on a shared DB.
- **Edge Cases (must be handled)**:
  - Error thrown anywhere in a `REQUIRED` call tree rolls back the **entire** transaction; verified absent on a **separate** connection.
  - `REQUIRES_NEW` inner transaction commits independently even when the outer transaction rolls back (proven via a second pooled connection).
  - **Connection-pool exhaustion via `REQUIRES_NEW` must fail fast, not hang.** Each active `REQUIRES_NEW` block holds an *additional* pooled connection for its lifetime while the parent still holds its own. If concurrent/nested `REQUIRES_NEW` blocks demand more connections than the pool has free, `pool.connect()` blocks — and with node-postgres's default `connectionTimeoutMillis: 0` ("wait forever") the request **deadlocks/hangs**. The library must not silently hang: consumers are directed to set a finite `connectionTimeoutMillis`, and an acquisition timeout surfaces a clear, actionable error.
  - `NESTED` savepoint rolls back only its own changes; the surrounding transaction still commits (partial rollback).
  - Reads inside a transaction via the **raw** base client (not the proxy) do **not** see uncommitted data — proves real isolation.
  - `@Transactional` applied to a **non-function** → thrown at class-definition time (a programming error at module load, not a runtime transaction op — outside the never-throw rule).
  - `@Transactional` method reached **before the `TransactionHost` is registered** (e.g. called during another provider's `onModuleInit`) → returns `err(HostNotInitialized)` at call time (Result-consistent, not a throw). See [ADR-0004](../adr/0004-decorator-resolves-host-via-static-registry.md).
  - Async context is preserved across `await` boundaries within the transactional callback (no context loss).
  - The decorator preserves other method metadata (so it composes with other NestJS decorators/guards/interceptors).
  - `NESTED` (or joining-`REQUIRED`) with `isolationLevel`/`accessMode`/`deferrable` supplied must **not** error — the options are stripped and a warning logged; the savepoint/join proceeds normally.
  - **Self-invocation is respected** (unlike Spring). Because the decorator replaces the prototype method with a `Proxy(original, { apply })`, an in-class call `this.otherTxMethod()` still goes through the transaction logic. A plain (undecorated) helper called from a transactional method automatically **inherits the ambient transaction via ALS** — no decorator needed. This must not regress: a "cleanup" that moves interception to an external proxy would silently break self-invocation.

## Design Decisions

### Technical Approach

- **Architecture Choice — framework-agnostic core + per-framework adapters** (monorepo).
  - *Chosen* over the simpler **"build on `@nestjs-cls/transactional`"** option. That option is faster and inherits a battle-tested engine, but `nestjs-cls` hard-depends on `@nestjs/core` and the Nest module system — it is structurally **NestJS-only** and cannot back a Hono/Express adapter. Since multi-framework support is the reason this package exists at all, we build a standalone core on raw `AsyncLocalStorage` and **learn from** (not depend on) `nestjs-cls`'s proven design: its `Propagation` semantics, adapter seam (`wrapWithTransaction`/`wrapWithNestedTransaction`/`getFallbackInstance`), and the static-registry decorator pattern.
  - *Also rejected*: putting everything in one package with subpath exports — muddies the peer-dependency story (core would drag NestJS peers) and blocks clean independent versioning of adapters.
- **Key Components**:
  - `@drizzle-tx/core`: `result` (thin in-house `Result` + `assertNever` — no external lib), `propagation` (const-object union), `errors` (exhaustive `DrizzleTxError` union), `adapter` (seam interface), `transaction-manager` (ALS + propagation switch), `drizzle-adapter` (Drizzle `pg` implementation, **async-only** in v1), `transactional-client` (Proxy), `logger` (a minimal injectable `{ warn(msg) }` seam, default namespaced `console.warn`, silenceable — used for advisory warnings like stripped tx options; keeps core dependency-free). The Nest adapter overrides it with a NestJS `Logger`-backed implementation.
  - `@drizzle-tx/nestjs`: `drizzle-transaction.module` (`forRoot`/`forRootAsync`), `transactional.decorator` (Proxy `apply` trap resolving the host from a **process-global static registry keyed by connection name** — the only mechanism available to a DI-less method decorator; ADR-0004), `transaction-host` (imperative API + DI; registers itself in the static registry on construction), `tokens`, `inject` (client/host injectors). Re-exports `Propagation` from core.
- **Data Storage**: none owned. Postgres via `pg` `Pool`; the manager is initialized with the **pool-backed base `db`** (not just a bound handle) so `REQUIRES_NEW` can acquire a fresh connection.
- **Interface Design**: mirrors the familiar Spring / `typeorm-transactional` / `nestjs-cls` surface (`@Transactional`, `Propagation`, `withTransaction`) to minimize learning curve, while the injectable tx-aware client is the headline DX win over vanilla Drizzle.

### Error Handling (explicit Result pattern — no implicit throws)

All library code uses an **explicit `Result` pattern** and does **not throw** for modeled conditions. A single internal `throw` is used **only** to trigger a Drizzle rollback and is caught at the same boundary — no throw escapes the engine. See [ADR-0003](../adr/0003-explicit-result-pattern-no-throw.md).

- **Thin in-house `Result`** — no external library (not `neverthrow`). `@drizzle-tx/core` exports `Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`, constructors `ok()/err()`, and `assertNever(x: never)` for compile-time exhaustiveness. Consumers are not coupled to a third-party Result type.
- **Exhaustive infrastructure error union `DrizzleTxError`** (v1 variants): `PoolConnectionTimeout` (REQUIRES_NEW fail-fast, ADR-0002), `TransactionAborted { cause: unknown }` (user work threw unexpectedly — wrapped, never re-thrown by core), `HostNotInitialized` (decorator/host used before Nest init), `NotPoolBacked` (REQUIRES_NEW on a non-`Pool` base, where detectable). New variants are additive; call sites `switch` on the tag with `assertNever` so adding one is a compile error until handled.
- **Rollback rule — `err` is a first-class rollback signal.** Inside a transaction: work returns `ok(v)` ⇒ commit ⇒ `ok(v)`; work returns `err(e)` ⇒ roll back ⇒ `err(e)` (your error, faithful — not swallowed into our union); work throws unexpectedly ⇒ roll back ⇒ `err(TransactionAborted{cause})`. A fully Result-style codebase rolls back **without ever throwing**.
- **Core imperative API is pure Result and fully typed** (the type-safe primary path): `withTransaction(work: () => Promise<Result<T, E>>): Promise<Result<T, E | DrizzleTxError>>` — never throws, and the `DrizzleTxError` variants are *visible in the return type*, so a `switch`/`assertNever` on the result is genuinely exhaustive.
- **`@Transactional` returns a `Result` and never throws** (`ok` commits; `err` rolls back and is returned; unexpected throws become `err(TransactionAborted)`). Applied to **service** methods, not controllers.
  - **Type-leak guard (critical).** A legacy (`experimentalDecorators`) method decorator **cannot widen the method's declared return type**, so decorator-injected infra errors would be *runtime-present but type-invisible* — silently defeating the exhaustive match. To prevent this, `@Transactional` is **typed to only accept methods whose declared return is `Promise<Result<T, E>>` where `DrizzleTxError extends E`** — i.e. the method must already include `DrizzleTxError` in its error union or it won't compile (see [ADR-0005](../adr/0005-typed-decorator-forces-drizzletxerror.md)). This keeps the exhaustive controller match honest.
  - If legacy-decorator inference can't *enforce* that constraint at compile time (to be validated in the Phase-1 spike), the fallback is: `withTransaction()` becomes the blessed type-safe path and the decorator ships with a documented "declare `DrizzleTxError` in your union" rule + a lint guard.
- **Controllers are the sole throw boundary**: unwrap the `Result` — return on `ok`; on `err`, **exhaustively match** the error union (`assertNever` guards completeness) and throw the appropriate `HttpException`. Nest's pipes/guards/exception filters continue to work because throwing is confined to this explicit boundary (and to Nest's own pre-service layers, which run outside the transaction).

### Constraints

- **Performance**: No hard latency budget. Guidance-level only: `AsyncLocalStorage` overhead is negligible on Node 20+/24 (Node's own docs call it "performant and memory safe"); keep the store statically shaped and free of request payloads; resolve the tx client once per hot loop rather than per row. The tx-aware Proxy resolves lazily per property access — acceptable, and documented as "grab the client once for bulk loops."
- **Compatibility**:
  - Runtime/dev on **Node LTS 24**; published `engines` `>=20` (NestJS 11 floor; `require(esm)` capable).
  - **`@drizzle-tx/core` ships dual ESM + CJS** so the **CJS** NestJS package `require()`s the CJS build deterministically (independent of the consumer's Node patch / bundler). Core avoids top-level `await` and module-level mutable singletons to neutralize the dual-package hazard.
  - Peers: `@nestjs/common`/`@nestjs/core` `^11`; `drizzle-orm` `^1.0.0-rc.4`; `reflect-metadata` `^0.2`; `rxjs` `^7.8`. `drizzle-orm` uses a peer range (not a hard dep) so the consumer controls the version.
  - **Connection pool (hard constraint for `REQUIRES_NEW`)**: the base `db` must be **`Pool`-backed** — a single `pg.Client` cannot host two independent top-level transactions, so `REQUIRES_NEW` is impossible on one. Pool `max` **must exceed the deepest concurrent `REQUIRES_NEW` nesting depth** or the app deadlocks (see Edge Cases). Consumers should set a finite `connectionTimeoutMillis` so exhaustion fails fast; the library documents this prominently and maps an acquisition timeout to a descriptive error. See [ADR-0002](../adr/0002-requires-new-needs-pool-and-can-deadlock.md).
  - NestJS 11 requires **legacy decorators** (`experimentalDecorators` + `emitDecoratorMetadata`), **not** TS 5 stage-3 — the Nest package is built with `tsc → CJS` accordingly.
- **Security**: No secrets handled; connection strings are the consumer's. No SQL is constructed by the library beyond delegating to Drizzle's transaction/savepoint primitives (no injection surface introduced). Errors must not leak connection credentials in messages (the `TransactionAborted.cause` wraps the original error as-is — document that consumers control its logging). **Supply chain**: published via npm **trusted publishing (OIDC)** from GitHub Actions — no long-lived `NPM_TOKEN`, automatic **provenance attestations** (public repo, npm CLI ≥ 11.5.1). Human maintainer account keeps 2FA on.
- **Scalability (near-term, real)**: the adapter seam + token design must make it additive — not a rewrite — to later add (a) the four remaining propagation modes, (b) lifecycle hooks, (c) named/multiple connections, and (d) Hono/Express adapters.

### Risk Assessment

- **Technical Risks**:
  - *Drizzle `1.0` is a release candidate (`rc.4`)* — API may shift before GA (notably relations v2 / `defineRelations`, and the `db.query` → v2 / `db._query` split). **Mitigation**: pin `1.0.0-rc.4` exactly in dev; verify the `defineRelations` and transaction API against the installed types (not 0.x examples); re-check the changelog before GA and widen the peer range only when stable.
  - *`REQUIRES_NEW` correctness + deadlock risk* — a fresh top-level `db.transaction()` must draw a *new* pooled connection while the parent still holds its own; on a bounded pool this can deadlock (see Edge Cases / Compatibility). **Mitigation**: require a `Pool`-backed base `db`; document the pool-sizing constraint and `connectionTimeoutMillis` guidance loudly; map acquisition timeouts to a clear error; integration-test both (a) inner-commits-while-outer-rolls-back on a third connection, and (b) a `max: 1` pool + nested `REQUIRES_NEW` **fails fast rather than hanging**. Recorded in [ADR-0002](../adr/0002-requires-new-needs-pool-and-can-deadlock.md).
  - *Decorator metadata under Vitest* — esbuild does not emit `design:paramtypes`. **Mitigation**: `unplugin-swc` with `legacyDecorator` + `decoratorMetadata` for the Nest package's Vitest config.
  - *Proxy + private-field receiver* — Drizzle's `db.query`/`select`/`insert` are getters/methods that read **private fields** (`#session`, `#dialect`). A naive `Proxy` using `Reflect.get(active, prop, proxyReceiver)` runs the getter with `this = proxy` and throws `Cannot read private member … from an object whose class did not declare it`. **Mitigation (firm design constraint, not to be "optimized" away)**: the `get` trap reads the property **off the real active client** (`active[prop]`) so getters/methods run with `this = the real Drizzle instance`, and binds returned functions to `active` — it never passes the proxy as the getter receiver. Integration tests cover both the builder **and** `db.query.*` (relations v2) inside and outside transactions.
  - *Async context loss* — event emitters / manual queues can break ALS. **Mitigation**: use `run()` (never `enterWith()`); document the boundary (extract primitives before handing off to background work).
- *Decorator ↔ host resolution* — the decorator finds its `TransactionHost` via a process-global static registry, not DI (ADR-0004). **Mitigation**: return `err(HostNotInitialized)` on miss; document that transactional methods must not be invoked during module construction, and that two Nest apps in one process sharing a connection name is unsupported. Vitest's `forks` pool gives each worker its own process/registry, so parallel integration tests are unaffected.
- **Dependency Risks**:
  - `tsdown` is pre-1.0. **Mitigation**: it is Rolldown/Oxc-backed and Vite-team-endorsed; the core has no decorators, so `tsc` is a drop-in fallback if `tsdown` regresses.
  - `pg`, `@testcontainers/postgresql`, `vitest@4`, `unplugin-swc`, `@swc/core` are all mainstream and actively maintained.
  - Testcontainers needs **Docker** available in dev/CI. **Mitigation**: document the requirement; CI provides Docker; consider a PGlite fast-path later (not v1).
- **Schedule Risks**: RQBv2 learning curve for `defineRelations`; Testcontainers cold-start flakiness; per-worker DB create+migrate adds startup cost per fork. **Response**: keep the test schema minimal; start the container once in `globalSetup` and reuse it across workers (each worker only creates+migrates its own lightweight DB); generous Vitest hook timeouts; disable Ryuk in CI if it interferes (`TESTCONTAINERS_RYUK_DISABLED`).

## Acceptance Criteria

### Functional Acceptance

- [ ] `@Transactional()` (REQUIRED) wraps a NestJS service method; multi-repository writes commit atomically; visible on a separate connection.
- [ ] A thrown error inside a REQUIRED method rolls back all writes; the rows are absent when queried on a separate connection.
- [ ] `Propagation.REQUIRES_NEW` commits the inner unit of work even when the outer transaction rolls back.
- [ ] `Propagation.NESTED` rolls back only to its savepoint; the surrounding transaction commits (partial rollback verified).
- [ ] A `max: 1` pool with a nested `REQUIRES_NEW` and a finite `connectionTimeoutMillis` **fails fast with a descriptive error** (does not hang) — deadlock failure mode is bounded and observable.
- [ ] Isolation/access-mode options reach Drizzle (e.g. `serializable`) **on a new top-level transaction**, and a read of uncommitted data via the raw base client returns nothing (isolation proven).
- [ ] `Propagation.NESTED` (and joining-`REQUIRED`) supplied with `isolationLevel` does **not** error — options are stripped + warned, savepoint/join proceeds.
- [ ] The tx-aware injectable client auto-joins the active transaction and falls back to the base connection outside one — for **both** insert/select and `db.query.*` (relations v2). `db.query.<relation>.findFirst()` inside a transaction returns tx-scoped data; outside, it hits the base connection. (Proxy reads off the real active client — no `TypeError` on Drizzle private fields.)
- [ ] `withTransaction()` imperative API produces identical behavior to the decorator.
- [ ] **No throws escape the library for modeled conditions**: `withTransaction` and `@Transactional` return a `Result`; `err` rolls back and is returned faithfully; an unexpected throw inside work rolls back and surfaces as `err(TransactionAborted)` (verified by a test that throws a raw error inside a transactional method and asserts a rolled-back `err`, not a thrown exception).
- [ ] The `DrizzleTxError` union is **exhaustively matchable**: a `switch` over its tag with `assertNever` compiles only when every variant is handled (a type-level test / the controller example demonstrates it).
- [ ] **No type-leak through the decorator**: a type-level test asserts that `@Transactional` applied to a method whose declared error union omits `DrizzleTxError` is a **compile error** (guard from ADR-0005); and that `withTransaction()`'s result type includes the `DrizzleTxError` variants.
- [ ] **Self-invocation works**: a `@Transactional()` method that internally calls `this.audit()` (a `@Transactional(REQUIRES_NEW)` method) runs the inner in its own transaction; and an undecorated helper called from a transactional method joins the ambient transaction.
- [ ] Core has **zero** runtime dependency on `nestjs-cls` or `@nestjs/*` (verified by inspecting `@drizzle-tx/core`'s dependency graph).
- [ ] `@drizzle-tx/core` is consumable from the CJS `@drizzle-tx/nestjs` package via `require()` with no interop error.

### Quality Standards

- [ ] **Test coverage**: core propagation switch unit-tested with a **fake adapter** (no DB) for all three modes + error paths (fully parallel); every functional criterion above covered by a **real-Postgres** integration test (Testcontainers `postgres:17-alpine`, **database-per-worker via `VITEST_POOL_ID`**, run in parallel), including cross-connection visibility assertions. Target ≥90% line coverage on `@drizzle-tx/core`.
- [ ] `publint --strict` and `attw --pack` pass for both packages (correct `exports`, types-first ordering, dual-format `.d.ts`/`.d.cts` for core).
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm biome check`, and `pnpm test` all pass in CI on a **Node 20 / 22 / 24 matrix** (dev on 24; the matrix proves the published `engines: >=20` claim).
- [ ] **Security review**: confirm no credential leakage in error messages; no dynamic SQL beyond Drizzle primitives.

### User Acceptance

- [ ] **User experience**: a NestJS + Drizzle app adds transactions by registering one module, injecting one client, and adding one decorator — no `tx` prop-drilling. Service methods return `Result`; the provided controller example shows exhaustive `err`→`HttpException` mapping.
- [ ] **Documentation**: root `README.md` (quick start + propagation table + limitations), per-package READMEs, `CLAUDE.md` (architecture map, commands, conventions, ALS/propagation gotchas, "never depend on nestjs-cls" rule), `docs/conventions.md`, and a runnable usage example in tests. Docs must call out the **deliberate differences from Spring**: self-invocation *is* respected, and undecorated helpers inherit the ambient transaction (so don't over-decorate).

## Execution Phases

### Phase 1: Preparation
**Goal**: Monorepo, toolchain, and technical validation.
- [ ] pnpm workspaces + `catalog:` (pin `drizzle-orm 1.0.0-rc.4`, `vitest@4`, `typescript`, etc.), `.nvmrc` (24), changesets.
- [ ] `biome.json`; root + per-package `tsconfig` (modern core; decorator-safe nestjs); `tsdown` config for core; `tsc` build for nestjs.
- [ ] Vitest 4 `test.projects` (parallel unit + integration projects, `pool: forks`); `unplugin-swc` for nestjs; Testcontainers `globalSetup` (start container once) + per-worker DB creation & migration keyed by `VITEST_POOL_ID`.
- [ ] Spike: confirm the exact Drizzle `1.0.0-rc.4` `defineRelations` + `db.transaction`/savepoint API against installed types.
- **Deliverables**: green empty build/test pipeline; validated Drizzle v1 API notes.
- **Estimate**: 0.5–1 day.

### Phase 2: Core Development
**Goal**: The v1 minimum engine + NestJS adapter.
- [ ] `@drizzle-tx/core`: `Propagation` const-union + errors; adapter seam; `TransactionManager` (ALS + REQUIRED/REQUIRES_NEW/NESTED switch); `DrizzleAdapter` (sync/async detection); `createTransactionalClient` Proxy.
- [ ] `@drizzle-tx/nestjs`: `DrizzleTransactionModule.forRoot/forRootAsync`; `TransactionHost` (static registry + imperative API); `@Transactional` (Proxy apply-trap + metadata copy); injection tokens/decorators.
- **Deliverables**: both packages build to their target formats; public API exported and typed.
- **Estimate**: 1.5–2 days.

### Phase 3: Integration & Testing
**Goal**: Prove real behavior and package health.
- [ ] Core unit tests (fake adapter): propagation decisions, join vs new, savepoint delegation, error propagation.
- [ ] Real-Postgres integration tests (core + nestjs): all functional acceptance criteria, cross-connection assertions, `db.query.*` under transactions.
- [ ] `publint` + `attw`; coverage; CI workflow on a **Node 20/22/24 matrix** with Docker (for Testcontainers).
- **Deliverables**: green CI; coverage report; passing `publint`/`attw`.
- **Estimate**: 1.5–2 days.

### Phase 4: Deployment
**Goal**: Documentation and (optional) first release.
- [ ] README(s), `CLAUDE.md`, `docs/conventions.md`, `CONTRIBUTING.md`, LICENSE (MIT).
- [ ] Create npm **org `drizzle-tx`**; set `publishConfig.access: "public"` on both packages; make the repo **public**.
- [ ] Changesets configured; **trusted-publisher (OIDC)** configured per package on npmjs.com pointing at the release workflow (`permissions: id-token: write`, npm CLI ≥ 11.5.1, **no `NPM_TOKEN`**); validate `changesets/action` drives `changeset publish` under OIDC with auto-provenance — fall back to a least-privilege granular automation token if it doesn't.
- [ ] Dry-run `changeset version` + `publish`; decide `0.1.0` initial publish vs. hold.
- **Deliverables**: docs complete; release pipeline validated (provenance attestation visible on the published package); version tag ready.
- **Estimate**: 0.5–1 day.

---

**Document Version**: 1.0
**Created**: 2026-07-07
**Out of Scope (v1)**: `SUPPORTS`/`NOT_SUPPORTED`/`MANDATORY`/`NEVER` propagation modes; non-Postgres drivers (MySQL/SQLite/Neon/etc.); post-transaction lifecycle hooks; multiple/named connections; Hono/Express/Fastify adapters; any runtime dependency on `nestjs-cls`.
