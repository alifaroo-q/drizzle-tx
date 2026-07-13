# Comparison: `@drizzle-tx` vs. `nickdeis/drizzle-transaction-context`

**Date:** 2026-07-13
**Subjects:**
- **Us** — `@drizzle-tx/core` + `@drizzle-tx/nestjs` (this repo)
- **Them** — [`nickdeis/drizzle-transaction-context`](https://github.com/nickdeis/drizzle-transaction-context) `v0.2.7`
- **Spec** — [drizzle-orm discussion #2777](https://github.com/drizzle-team/drizzle-orm/discussions/2777) "implicit transaction context"

Both projects exist to answer the *same* discussion (#2777): kill transaction prop-drilling by carrying the active Drizzle transaction through the async call tree on `AsyncLocalStorage`/`async_hooks`. Nick's library is, in fact, the maintainer-adjacent reference implementation @nickdeis posted *in* that discussion. So this is a direct head-to-head of two takes on one spec.

---

## 1. The spec (#2777) — what's actually being asked for

@agcty's ask, distilled:

- **`withTransaction()` / `useTransaction()`** — implicit scope + implicit retrieval, no threading the tx through signatures.
- Automatic rollback on exception.
- Support for isolation levels & timeouts.
- Strong TS inference; minimal overhead.
- Open design questions the thread raised: **core-vs-plugin**, `AsyncLocalStorage` **perf** (old Node), **nested transactions / savepoint scoping**, and **safety** for out-of-context misuse.

@nickdeis answered with a working library and the perf data point: **Node 24+ ≈ negligible; older Node ≈ 7–20% CPU** on ALS. That's the number both of us inherit.

**Read:** neither project is speculative — the spec is real demand, and the two implementations diverge sharply on philosophy. That divergence is the interesting part.

---

## 2. Side-by-side

| Dimension | **Them** (`drizzle-transaction-context`) | **Us** (`@drizzle-tx`) |
| --- | --- | --- |
| **Core primitive** | `createTransactionContext(db, opts)` → `{ withTransaction, useTransaction, withSavePoint, useSavePoint, … }` | `createDrizzleTx()` engine: ALS context + propagation switch + adapter seam; NestJS `TransactionHost` / `@Transactional` on top |
| **Context mechanism** | `node:async_hooks` (ALS) | `AsyncLocalStorage.run()` only — `enterWith` forbidden by ADR (leak-safe) |
| **Retrieval** | Explicit `useTransaction()` / `useSavePoint()` call | Transparent **Proxy** client (`DRIZZLE_TX_CLIENT`) — repos never call a "get tx" fn; the injected `db` *is* tx-aware |
| **Propagation modes** | 1 real mode (single tx) + **unlimited savepoint nesting**. Nested `withTransaction` = error (or "run in parent" under safeMode) | **3 Spring modes**: `REQUIRED` (join), `REQUIRES_NEW` (independent tx on a fresh pooled conn), `NESTED` (SAVEPOINT) |
| **Nested tx semantics** | No `REQUIRES_NEW`. Re-entrancy collapses into the parent or errors | First-class `REQUIRES_NEW` — genuinely independent commit/rollback |
| **Error model** | **Throws.** `AlreadyRunningTransactionError`, `NoRunningTransactionError`; `safeMode` downgrades to logged warnings | **Never throws for modeled conditions.** `Result<T,E>`; `err` *is* the rollback signal. Throw only at the controller boundary |
| **Error taxonomy** | Two misuse errors | Discriminated `DrizzleTxError` union — `PoolConnectionTimeout`, `TransactionAborted`, `HostNotInitialized`, `NotPoolBacked`, `ConnectionLost`, `DeadlockDetected`, `SerializationFailure` — exhaustive-matched via `assertNever` |
| **Drivers** | **All** Drizzle drivers — PG / MySQL / SQLite, sync & async | **Postgres + `Pool` only** (v1). MySQL/SQLite/sync are declared out-of-scope seams |
| **Decorators** | `@Transactional`, `@SavePoint` — framework-agnostic, no DI needed | `@Transactional` (NestJS), resolved via process-global `TransactionHost` registry (method decorator = no DI) |
| **Framework story** | None needed — works anywhere (also usable in Nest without DI) | Deep **NestJS** integration (module, `forRootAsync`, injectable proxy, `matchError` → `HttpException`) |
| **Scope API** | Callback only | Callback **+** `await using` disposable scope (`begin()`, default-deny rollback) |
| **Safety migration aid** | **`safeMode`** — logs instead of throws so you can adopt incrementally, then turn it off | Compile-time: `@Transactional` return type *must* include `DrizzleTxError` (ADR-0005); exhaustiveness enforced by `test-d` |
| **Packaging** | Single package, ESM+CJS, `tsc`+bun, drizzle-orm peer `^0.44.7` | Monorepo, core dual ESM+CJS (tsdown) with drizzle-orm as **optional** peer (structural types only); nestjs CJS (tsc) |
| **Testing utils** | pglite-based test suite (dev only) | Shipped `./testing` surface: `NoOpAdapter`, **`FaultInjectingDrizzleAdapter`** for classifying failure scenarios |
| **Maturity** | v0.2.7, active | Pre-release, richer engine, more docs/ADRs |

---

## 3. What they do better (things we should consider stealing)

### 3a. Multi-driver support — their biggest edge
They work with **every** Drizzle driver (PG/MySQL/SQLite, sync and async) because they lean on Drizzle's own `db.transaction()` callback and just parmeterize the client type. We are **Postgres + Pool only** and gate `REQUIRES_NEW` on pool-backing. For a library whose whole pitch is "drop it into your Drizzle app," single-driver is a real adoption ceiling. Our adapter seam (`adapters/port.ts`) is explicitly designed for this — MySQL/SQLite adapters are declared future work. **Their existence is proof the demand spans drivers.** Worth pulling the SQLite/MySQL adapter forward on the roadmap.

### 3b. `safeMode` as a migration on-ramp
Their `safeMode` (log-instead-of-throw for nested `withTransaction`, out-of-context `useTransaction`, etc.) is a genuinely nice **adoption** story: sprinkle the calls into a legacy codebase, watch the warnings, fix them, then flip safeMode off. We enforce correctness at *compile* time (stronger, but higher up-front cost). We could offer an analogous **dev-mode diagnostic**: a logger-backed "you called the proxy client outside any transaction context and it silently fell through to the base client" warning. That specific footgun (proxy resolving to base client when the dev *thought* they were in a tx) is invisible in our current design — a `safeMode`-style warn would surface it. Low cost, real value.

### 3c. Zero-framework decorators
Their `@Transactional`/`@SavePoint` work with **no DI container** at all — pure `async_hooks`. Ours needs the NestJS `TransactionHost` global registry. As we build the Next.js/tRPC adapters (roadmap #11–#15), a **framework-free decorator/wrapper** — usable in plain TS services — would broaden reach and is architecturally close to what those adapters already need.

### 3d. `contextDepth()` / `currentSavePointName()` introspection
Small but pleasant debugging affordances. We have `isTransactionActive()` but no depth or savepoint-name introspection. Cheap to add, helps users reason about nesting.

### 3e. pglite in tests
They test on `@electric-sql/pglite` — in-process Postgres, no Docker/Testcontainers. Our integration tests need a Docker daemon. A pglite-backed **fast unit lane** for propagation logic (that today needs the fake adapter) could shave a lot off local iteration without giving up real-SQL fidelity. Worth a spike.

---

## 4. What we do better (our moat)

1. **`REQUIRES_NEW` — genuinely independent transactions.** Their model has no equivalent: nested `withTransaction` either errors or folds into the parent. Ours draws a *fresh pooled connection* so an inner unit can commit while the outer rolls back (audit logs, outbox rows). This is the single biggest capability gap in our favor and directly answers the spec's "nested transactions" open question with the full Spring matrix, not just savepoints.

2. **`Result`-not-throws.** They throw; `safeMode` only downgrades *their own* misuse errors to logs — the underlying DB/tx errors still throw. Our whole contract is modeled: `ok` commits, `err` rolls back and is returned faithfully, an unexpected throw becomes `err(TransactionAborted)`. Domain errors `E` are never folded into infra errors. This is a materially different (and, for well-typed apps, safer) contract.

3. **Exhaustive, discriminated error taxonomy.** `PoolConnectionTimeout`, `DeadlockDetected`, `SerializationFailure`, `ConnectionLost`, etc. — classified and `assertNever`-matched. Adding a variant is a compile-caught breaking change at every `switch`. They have two misuse errors and otherwise pass DB errors through raw.

4. **Transparent proxy client > explicit `useTransaction()`.** Repos inject a normal-looking `db` and never call a "give me the tx" function — the proxy resolves to active-tx-or-base transparently. Their `useTransaction()` is an explicit call at every site (more honest, but more ceremony and more places to forget).

5. **`await using` scope API.** Disposable, default-deny-rollback scope for imperative flows that want explicit resource management. They're callback-only.

6. **Pool-exhaustion / deadlock hardening.** Finite `connectionTimeoutMillis` → `err(PoolConnectionTimeout)` instead of hanging forever; documented pool-sizing-vs-nesting-depth rule (ADR-0002). This is exactly the operational sharp edge `REQUIRES_NEW` introduces, and we've engineered around it.

7. **`FaultInjectingDrizzleAdapter`.** A shipped testing surface for classifying failure scenarios — no equivalent on their side.

8. **Docs/ADR rigor + functional-core/imperative-shell split.** Pure decision modules (`propagation-plan`, `rollback-boundary`) unit-testable without a DB; effects isolated in the shell. Higher engineering maturity for a library others build on.

---

## 5. Ideas worth lifting — ranked

| Idea | Value | Cost | Verdict |
| --- | --- | --- | --- |
| **MySQL/SQLite adapter** (their multi-driver reach) | High — removes adoption ceiling | Med (seam exists) | **Roadmap it.** Pull forward once core quality tickets (#20–#24) land |
| **`safeMode`-style dev warning** for proxy-falls-through-to-base-client | Med-High — surfaces our one invisible footgun | Low | **Do it.** Logger-backed, dev-only, off in prod |
| **Framework-free `@Transactional`/wrapper** (no DI) | High — Next.js/tRPC roadmap needs this anyway | Med | **Fold into #11–#15 adapter design** |
| **pglite fast test lane** | Med — faster local iteration, no Docker | Low-Med | **Spike it** |
| **`contextDepth()` / savepoint-name introspection** | Low-Med — nice debugging | Low | **Cheap add** alongside `isTransactionActive()` |
| **Their `useTransaction()` escape hatch** (explicit tx access) | Low — we have `host.tx` / `scope.tx` already | — | Already covered |

---

## 6. Bottom line

**Same spec, opposite philosophies.** They optimize for *breadth and easy adoption*: every driver, no framework, throw-with-a-safety-net. We optimize for *depth and correctness*: full Spring propagation (esp. `REQUIRES_NEW`), a no-throw `Result` contract, an exhaustive error taxonomy, and operational hardening around pool exhaustion — at the cost of being Postgres-only and NestJS-first today.

The two genuinely-actionable things they expose:
1. **Our single-driver, single-framework scope is our real constraint** — their multi-driver, DI-free reach is the adoption ceiling we should attack (adapter seam + framework-free wrapper are already designed for it).
2. **Our transparent proxy has one invisible failure mode** (silent fall-through to base client outside a tx). A `safeMode`-style dev warning closes it cheaply.

Everything else in their design, we either already do or deliberately chose not to. Our engine is the more capable one; the gap to close is *coverage*, not *design*.

---

### Sources
- Repo: https://github.com/nickdeis/drizzle-transaction-context (`README.md`, `package.json` @ v0.2.7)
- Spec: https://github.com/drizzle-team/drizzle-orm/discussions/2777
- Ours: `README.md`, `CLAUDE.md`, `packages/core/src/{errors,propagation,propagation-plan}.ts`, ADR-0001…0006
