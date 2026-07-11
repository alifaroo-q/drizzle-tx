# Analysis: @drizzle-tx — 10x Opportunities

Session 1 | Date: 2026-07-11

## Current Value

**What it does.** `@drizzle-tx` gives Drizzle ORM Spring-`@Transactional`-style *implicit* transaction propagation on Node `AsyncLocalStorage`, so a `tx` handle never has to be prop-drilled. A developer registers one module, injects **one** transactional client (a `Proxy` that resolves to the active tx or the base client — [transactional-client.ts](../../packages/core/src/transactional-client.ts)), and marks an orchestration method `@Transactional()`. Every Drizzle query in that call tree joins one transaction and commits/rolls back atomically.

**The core action** (where users spend time): writing services + repositories that compose multi-repository units of work, then reasoning about *when* those writes are atomic. The library removes the plumbing (`tx`-passing) and the propagation decision (join / new / savepoint) from that loop. Concretely the engine is a thin coordinator — snapshot ALS → `planTransaction` → interpret the plan ([transaction-manager.ts:81-106](../../packages/core/src/transaction-manager.ts#L81-L106)) — over three modes: `REQUIRED` / `REQUIRES_NEW` / `NESTED` (savepoints).

**Who uses it.** The author's production NestJS + Postgres work ([drizzle-tx-v1.0-prd.md:10-13](../prds/drizzle-tx-v1.0-prd.md)); and — as an *intended but unrealized* audience — developers on other Node frameworks who want the same ergonomics that today only exist for NestJS via `@nestjs-cls/transactional`.

**What's distinctive today.**
- **Explicit `Result`, never throw** — `ok` commits, `err` rolls back and is returned faithfully; consumer domain errors are never folded into the exhaustive `DrizzleTxError` union ([errors.ts:1-5](../../packages/core/src/errors.ts#L1-L5)). This directly answers Drizzle's most-reported tx pain: rollback confusion (`tx.rollback()` throwing — drizzle-orm #1447, #1723).
- **Real NESTED/savepoint semantics** — the strongest differentiator vs the incumbent (`@nestjs-cls/transactional`'s Nested is adapter-gated and *undocumented for Drizzle*).
- **`await using` scope API** (`begin()`) — a block-scoped, callback-free transaction handle ([transaction-scope.ts:15-22](../../packages/core/src/transaction-scope.ts#L15-L22)). This is the load-bearing primitive for framework adapters that can't use decorators.
- **Framework-agnostic core** — zero runtime dep on `@nestjs/*` (ADR-0001). The engine is ready to back non-Nest adapters; nothing yet does.

**What the market says** (web research, primary sources):
- The need is **validated and explicitly declined by Drizzle core**: AsyncLocalStorage-for-tx (drizzle-orm [#543](https://github.com/drizzle-team/drizzle-orm/issues/543), open since May 2023), transactional propagations ([#1473](https://github.com/drizzle-team/drizzle-orm/issues/1473), closed with no core impl), and the "Implicit Transaction Context" proposal ([discussion #2777](https://github.com/drizzle-team/drizzle-orm/discussions/2777), steer = "do it as a plugin"). Userland is the sanctioned home.
- The **Drizzle-specific competitive field is weak**: one polished-but-unpublished repo ([nickdeis/drizzle-transaction-context](https://github.com/nickdeis/drizzle-transaction-context), ~18★), one published-but-tiny repo ([herenickname/drizzle-transactional](https://github.com/herenickname/drizzle-transactional), ~5★, PG-only, but *already ships afterCommit hooks*), and the NestJS-coupled `@nestjs-cls/transactional-adapter-drizzle-orm`.
- **General appetite is proven**: `typeorm-transactional` ~59k weekly downloads; `nestjs-cls` ~740k weekly; MikroORM shipped a *native* `@Transactional()` and the full 7-mode propagation set ([#6788](https://github.com/mikro-orm/mikro-orm/issues/6788) → PR #6802).

## The Question

What would make `@drizzle-tx` 10x more valuable — turn it from "a nice NestJS tx helper" into the default transaction layer every Drizzle app reaches for?

---

## Massive Opportunities

### 1. Ship the framework adapters the core was built for (Next.js Server Actions / tRPC / Hono / Fastify / Express) — **design settled + de-risked, see [ADR-0009](../adr/0009-framework-adapters-node-only-and-result-throw-bridge.md) + [next-trpc-adapter-design.md](next-trpc-adapter-design.md)**

**What**: Realize the framework-agnostic promise. A per-request/per-action transaction scope for the frameworks Drizzle users *actually* pair with — **tRPC first, then Next.js Server Actions**, then generic Hono/Fastify/Express. The decorator-less primitives already exist — `withTransaction` ([transaction-manager.ts:37-58](../../packages/core/src/transaction-manager.ts#L37-L58)) and the `begin()`/`await using` scope ([transaction-scope.ts](../../packages/core/src/transaction-scope.ts)).

**Why 10x**: The PRD names *multi-framework support as the reason this package exists at all* ([prd:14, 72-73](../prds/drizzle-tx-v1.0-prd.md)) — yet only NestJS ships. NestJS is a *fraction* of the Drizzle audience; **Next.js App Router + Server Actions + tRPC is by far the most common Drizzle pairing** (research). Today those developers have *no* implicit-propagation option — `@nestjs-cls/transactional` is structurally NestJS-only. This is the single move that changes the addressable market from "NestJS teams" to "every Drizzle app on Node."

**Settled design** (research + a live tRPC spike; full detail in the design doc + ADR-0009):
- **Layout**: `createDrizzleTx({ db })` non-DI factory in **core** (single canonical assembly path — the NestJS module refactors to delegate to it), + separate `@drizzle-tx/trpc` (tRPC isn't Next-specific) + `@drizzle-tx/nextjs`.
- **tRPC bridge de-risked (spike GREEN)**: per-procedure middleware drives commit/rollback from `next().ok` with no throw for domain errors; infra-only `TRPCError`. **Never open the tx in `createContext`** (batch-merge hazard).
- **Server Action HOF returns core's `Result`** (consistent with `@Transactional`; serializable across RSC; typed errors survive to client); `throwOnErr`/`.orThrow()` escape hatch + compose-under-next-safe-action recipe.
- **Node-runtime-only for tx** (edge can't pool Postgres; confirmed for Next.js **16**); driver gate: `pg.Pool`/Neon-WebSocket ✅, **Neon-HTTP ❌ hard-unsupported**, PgBouncer txn-mode ⚠️. New Next-16 docs caveat: never run a tx inside `"use cache"`.

**Unlocks**: A category position ("the Drizzle transaction layer, any framework") no competitor can occupy without a rewrite. Each adapter is a distribution channel; it also forces core's agnostic seams to stay honest.

**Effort**: Medium (core primitives exist; adapters are thin sugar + conventions + one now-de-risked bridge).
**Risk**: Mostly retired — ALS reliability, the Result↔throw bridge, tRPC batching, and Next 16 compatibility are all resolved. Residual: serverless connection/driver caveats, handled by the driver gate + docs.
**Score**: 🔥 Must do

### 2. Multi-driver support (postgres.js, Neon serverless, then MySQL / SQLite / edge)

**What**: Break the `pg`-only ceiling. The `DrizzleAdapter` is async-only + `pg.Pool`-structural today ([adapters/drizzle.ts](../../packages/core/src/adapters/drizzle.ts) `isPoolBacked`). Add **postgres.js** and **Neon serverless** first (same async callback model → cheap), then the MySQL and sync-SQLite (`better-sqlite3`) paths (backlog item F).

**Why 10x**: Drizzle's *whole* value proposition is portability across drivers/runtimes (Neon, PlanetScale, D1, Bun, Turso — research). A propagation library that only works on node-postgres excludes most of Drizzle's serverless/edge audience. postgres.js + Neon alone are a large, cheap reach expansion.

**Unlocks**: The serverless/edge Drizzle market; pairs naturally with the Next.js adapter (Neon + Server Actions is a canonical stack).
**Effort**: Medium (postgres.js/Neon cheap; MySQL/sync-SQLite is real work — sync drivers throw synchronously on rollback and need a `Promise.reject` bridge, and Drizzle *itself* has async-tx bugs on 4/5 SQLite drivers per [drizzle-orm #2275](https://github.com/drizzle-team/drizzle-orm/issues/2275), plus AWS Data API can't do savepoints).
**Risk**: Per-driver correctness matrix balloons the test surface; some drivers can't honor `REQUIRES_NEW`/`NESTED`. Gate features per adapter capability flag.
**Score**: 🔥 Must do (postgres.js + Neon) / 👍 (rest)

### 3. Transactional outbox helper — **design settled, see [ADR-0008](../adr/0008-transactional-outbox-poll-first-cdc-later.md)**

**What**: A first-class helper that writes an event row to an outbox table *inside the ambient transaction* (`enqueue(event)` — atomic with the business writes by construction, because it's just another insert on the injected transactional client), plus an engine-independent relay that publishes committed events at-least-once. Folded into `@drizzle-tx/core` behind a `@drizzle-tx/core/outbox` subpath + optional peer deps.

**Why 10x**: **Nobody ships this well for Drizzle.** The closest is `Zehelein/pg-transactional-outbox` (raw `pg`, not Drizzle-native). This turns the library from "tx ergonomics" into the *reliable event-driven backbone* for a Drizzle app — a category no competitor occupies. It compounds (dispatcher, dedup, ordering, CDC) into a genuine moat. The producer is *atomic for free* — the single crispest "belongs in this library" argument (it inherits the ambient transaction from the propagation engine).

**Settled design** (research synthesis in ADR-0008):
- **Producer / relay split via the outbox table as the seam.** Producer is engine-resident (ALS-aware); relay is engine-*independent* — `drainOnce()` is the unit, wrapped by an in-process loop, an out-of-process worker, or a serverless single-shot cron drain, all from the same primitive.
- **Poll-first, CDC-later.** Default dispatch = polling with `SELECT … FOR UPDATE SKIP LOCKED` (portable, zero DB feature-gating, degrades to serverless). CDC / logical replication is a deferred opt-in listener behind the same table contract (feature-gated `wal_level=logical`, ops-heavy — wrong default).
- **At-least-once + consumer dedup** (UUID `id` per event); never advertise exactly-once. **Per-aggregate best-effort ordering, no global order**; claim by `processed_at IS NULL` + `SKIP LOCKED`, never an `id > cursor` high-water mark (the commit-order-vs-insert-order hazard silently drops events). **Publish outside any DB transaction** (ADR-0002 rule). Table schema = a superset of Debezium's columns.

**Unlocks**: Event-driven / microservice teams; a reason to standardize on `@drizzle-tx` org-wide.
**Effort**: High (relay modes, delivery/ordering guarantees, schema + purge strategy) — but the seam is drawn so poll-only ships without foreclosing CDC.
**Risk**: Scope creep into a messaging framework; narrower reach than #1/#2. Sequence after the reach plays.
**Score**: 👍 Strong (defensibility play — the depth-phase capstone after the Next.js flagship)

---

## Medium Opportunities

### 1. Automatic retry on serialization_failure (40001) / deadlock_detected (40P01)

**What**: `@Transactional({ retry: { maxAttempts, backoff } })` / `withTransaction({ retry }, …)` that transparently re-runs the *entire* transaction callback on Postgres `40001`/`40P01`. The engine already owns the whole unit of work as a callback ([transaction-manager.ts:108-120](../../packages/core/src/transaction-manager.ts#L108-L120)) — retry is a loop around it.

**Why 10x**: At `REPEATABLE READ`/`SERIALIZABLE`, Postgres *requires* application-side retry ([PG docs](https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html)) — and **no Drizzle-native answer exists**. Rails and CockroachDB stacks ship this; Node ORMs largely don't. It makes correct high-concurrency code *trivial* instead of hand-rolled.
**Impact**: Anyone using Serializable, high-contention writes, or hitting deadlocks gets correctness for one option. Strong differentiator, clean architectural fit.
**Effort**: Medium (retry loop + error-code classification; interacts with `REQUIRES_NEW` connection handling and idempotency of side effects — document that only the tx body retries).
**Score**: 🔥 Must do

### 2. Post-commit lifecycle hooks (afterCommit / afterRollback / afterComplete)

**What**: `txHost.onCommit(fn)` / `onRollback(fn)` (and a decorator equivalent), draining a per-tx queue *after* the boundary settles. The PRD explicitly left the seam ([prd:27, 104](../prds/drizzle-tx-v1.0-prd.md)).

**Why 10x**: This kills the **#1 silent correctness bug** in transactional code — firing a side effect (send email, publish event, invalidate cache) *before* the tx commits, so it fires even on rollback. Spring, `typeorm-transactional`, and the 5★ `drizzle-transactional` all ship it; its absence is a credibility gap. It composes perfectly with the `Result` boundary.
**Impact**: Broad — nearly every real service has "do X only after this commits." Table-stakes vs competitors + a genuine bug-killer.
**Effort**: Low–Medium (per-tx callback queue keyed to ALS context; run on commit path, discard on rollback).
**Score**: 🔥 Must do

### 3. OpenTelemetry span-per-transaction

**What**: Auto-instrument each transaction as an OTel span with events for commit / rollback / retry-count / propagation-mode / savepoint-depth. The engine already knows all of this (`plan.kind`, depth, `Result`).

**Why 10x**: Drizzle's own OTel experiment was **disabled and "does nothing"** (research); observability is unmet demand filled only by third-party query-level tools (`@kubiks/otel-drizzle`). A transaction-scoped span is a level of insight nobody offers — "which propagation mode, how deep, did it retry, how long held."
**Impact**: Production teams debugging slow/held transactions and lock contention. Broad appeal, differentiator.
**Effort**: Medium (optional peer dep on `@opentelemetry/api`; a logger-style seam so core stays dependency-free).
**Score**: 👍 Strong

### 4. Full propagation set (MANDATORY / NEVER / SUPPORTS / NOT_SUPPORTED)

**What**: Complete the Spring matrix (backlog item E). `MANDATORY`/`NEVER` are cheap assertions on `isActive()`; `SUPPORTS`/`NOT_SUPPORTED` need a new `TransactionContext.runWithout` "suspend" seam.

**Why 10x**: MikroORM validated that the *full* 7-mode set is the "serious library" bar (research). It's less a differentiator than **table-stakes for credibility** against `@nestjs-cls/transactional` (7 modes) — the gap invites "why only three?"
**Impact**: Feature-parity credibility; `MANDATORY` in particular guards "this must run inside a caller's tx" invariants cheaply.
**Effort**: Low (`MANDATORY`/`NEVER`) → Medium (`SUPPORTS`/`NOT_SUPPORTED` — ADR-worthy suspend primitive + 2 new error variants, compile-caught at every `assertNever`).
**Score**: 👍 Strong (ship `MANDATORY`/`NEVER` first)

### 5. Transaction-aware read-replica routing

**What**: Bind Drizzle's `withReplicas()` routing to the ALS context: reads *inside* a write-tx pin to primary; a read-only tx can pin to a replica; reads outside a tx hit replicas.

**Why 10x**: Drizzle's `withReplicas()` is *query-level random routing* — **not** tx-aware ([docs](https://orm.drizzle.team/docs/read-replicas)). A transaction that reads-then-writes can silently read stale replica data. Making routing transaction-context-aware is a real, unfilled correctness+performance gap.
**Impact**: Scaled apps with replicas (narrower reach than hooks/retry, but high value where it applies).
**Effort**: Medium–High (routing correctness, read-only-tx detection, interaction with `REQUIRES_NEW`).
**Score**: 🤔 Maybe (Explore — high value, narrower audience)

---

## Small Gems

### 1. Escaped-write "safe mode" (dev-only warning)

**What**: In development, warn when a *mutating* query runs on the base client while a transaction is active elsewhere in the call tree — i.e. a repo that grabbed the raw `db` instead of the injected transactional client, silently escaping atomicity.
**Why powerful**: This is *the* dominant silent bug the PRD itself calls out ("a repository silently using the base `db` instead of the active `tx`… breaks atomicity" — [prd:9](../prds/drizzle-tx-v1.0-prd.md)). It's invisible until data corrupts in prod. `isTransactionActive()` already exists ([transaction-manager.ts:32-34](../../packages/core/src/transaction-manager.ts#L32-L34)); prior art exists (nickdeis "safe mode"). One eliminated class of anxiety.
**Effort**: Low
**Score**: 🔥 Must do

### 2. Rollback-per-test harness (`withRollback`)

**What**: A testing utility that wraps each test body in a transaction and rolls back at teardown — fast test isolation with no truncate/reseed. Complements the existing `NoOpDrizzleAdapter` (ADR-0007, [testing.ts](../../packages/core/src/testing.ts)).
**Why powerful**: Testing transactions is a named pain point (research). Rollback-per-test is a beloved pattern (Rails/`database_cleaner`) with no Drizzle-native helper. Big DX win, small surface.
**Effort**: Low–Medium
**Score**: 👍 Strong

### 3. Transaction timeout option

**What**: `@Transactional({ timeout })` mapping to `statement_timeout` / `idle_in_transaction_session_timeout` so a hung transaction fails fast instead of holding a connection.
**Why powerful**: Long-open-transaction pain is real (Prisma users hit it; research). One option that turns a silent connection-hog into a clean `err`. Pairs with the `REQUIRES_NEW` pool-exhaustion story (ADR-0002).
**Effort**: Low
**Score**: 👍 Strong

### 4. Named/multiple connections (finish the wiring)

**What**: The v1 groundwork is already honest-but-stubbed — registry is a `Map`, `HostNotInitialized` already carries `connectionName` (backlog item H). Finish it: two DBs / two pools in one app.
**Why powerful**: Common in modular monoliths (billing DB + catalog DB); today the second DB's writes silently run non-transactionally. Small *incremental* surface because the seams exist.
**Effort**: Medium (must document the no-2PC boundary — an ADR).
**Score**: 🤔 Maybe

---

## Recommended Priority

### Do Now

1. **Framework adapters — Next.js Server Action + tRPC first** (Massive #1). Realize the stated raison d'être; escape the NestJS-only ceiling. Highest leverage, primitives already exist.
2. **Post-commit lifecycle hooks** (Medium #2). Cheap, table-stakes, kills the "side-effect-before-commit" bug.
3. **Retry on 40001/40P01** (Medium #1). Clean fit, genuinely unmet, differentiator.
4. **Escaped-write safe mode** (Gem #1). Low effort, kills the dominant silent atomicity bug.

### Do Next

1. **postgres.js + Neon driver support** (Massive #2, cheap slice) — pairs with the Next.js adapter.
2. **OpenTelemetry tx spans** (Medium #3).
3. **`MANDATORY`/`NEVER` propagation** (Medium #4, cheap slice) — parity credibility.
4. **Rollback-per-test harness** + **transaction timeout** (Gems #2, #3).

### Explore

1. **Transactional outbox** (Massive #3) — the moat/defensibility play; sequence after reach.
2. **Transaction-aware replica routing** (Medium #5) — high value, narrower audience.
3. **MySQL / sync-SQLite / edge drivers** and **`SUPPORTS`/`NOT_SUPPORTED`** suspend seam — real work, gated by driver capability and an ADR.
4. **Named/multiple connections** (Gem #4) and an **Effect adapter** (niche).

---

## Questions

### Answered

- **Q**: Is implicit propagation something Drizzle will absorb into core, making this package redundant? **A**: No — Drizzle core has repeatedly declined (drizzle-orm #543, #1473, discussion #2777) and steers users to userland plugins. Userland is the sanctioned home.
- **Q**: Does the framework-agnostic bet have a real market, or is NestJS the whole audience? **A**: Real and larger — Next.js Server Actions/tRPC is the most common Drizzle pairing and has *no* implicit-propagation option today; `@nestjs-cls/transactional` is structurally NestJS-only.
- **Q**: Are the differentiators defensible? **A**: Real NESTED/savepoint semantics + explicit `Result` error model already answer competitors' top pains; framework-agnosticism + outbox compound into a moat.

- **Q**: Which framework adapter ships first? **A** *(decided 2026-07-11)*: **Next.js Server Actions** — the biggest Drizzle audience and the highest-demand gap. First proof point that the agnostic core backs a decorator-less framework.
- **Q**: Breadth (reach) or depth (moat)? **A** *(decided 2026-07-11)*: **Both, sequenced** — land the Next.js flagship adapter as the breadth proof, then build depth (hooks → retry → OTel → outbox) on the NestJS/Postgres beachhead. This keeps "Do Now" intact and pulls the outbox out of pure "Explore" into a scheduled depth phase after the flagship ships.
- **Q**: Companion packages vs fold OTel + outbox into core? **A** *(decided 2026-07-11)*: **Fold into `@drizzle-tx/core`** behind **optional peer deps** (`@opentelemetry/api`, and a driver/broker peer for the outbox relay), gated so core stays zero-*required*-dependency and dead-code-free when unused. Constraints this imposes (see Constraints below): the OTel/outbox surfaces must sit behind the existing seam pattern (logger-style injection, subpath export like `@drizzle-tx/core/otel`), must not add a top-level `import`, and must not break the dual ESM+CJS build or `publint`/`attw`.

### Blockers

- *(none — all strategic decisions resolved)*

## Next Steps

- [ ] **Spike (gating):** confirm ALS survives the Next.js Server Action boundary (App Router + edge/Node runtime) — this de-risks the whole flagship bet before building the adapter.
- [ ] Design the `@drizzle-tx/next` surface: a `withTransaction`-wrapped Server Action helper reusing the imperative `withTransaction` / `begin()` scope; document the pool/`REQUIRES_NEW` caveats for serverless.
- [ ] Sequence the depth phase behind the flagship: post-commit hooks → retry-on-40001/40P01 → OTel spans → outbox — **all in `@drizzle-tx/core`** behind optional peer deps + subpath exports (`@drizzle-tx/core/otel`, `@drizzle-tx/core/outbox`), no new top-level imports, dual ESM+CJS + `publint`/`attw` kept green.
- [ ] Validate: retry loop interaction with `REQUIRES_NEW` connection acquisition and side-effect idempotency.
- [ ] Research: postgres.js + Neon adapter effort against the existing `DrizzleAdapter` structural pool detection (companion to the Next.js/Neon stack).
- [ ] Confirm the optional-peer-dep seam: OTel via a logger-style injectable (`@opentelemetry/api` as `optional` peer), outbox relay driver/broker as `optional` peer — core resolves to a no-op when absent.
