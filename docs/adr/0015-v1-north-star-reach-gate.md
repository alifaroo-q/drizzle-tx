# v1 north star: implicit propagation for the Drizzle apps people run, with a gate that decides the default surface

**Status: Accepted.** Decided in grilling on #36, under the re-baseline map #35 (plan-only). It frames [ADR-0002](0002-requires-new-needs-pool-and-can-deadlock.md), [0003](0003-explicit-result-pattern-no-throw.md), [0005](0005-typed-decorator-forces-drizzletxerror.md), [0009](0009-framework-adapters-node-only-and-result-throw-bridge.md), [0010](0010-driver-capability-gate-throws-at-assembly.md), [0011](0011-result-is-the-core-adapter-author-contract.md) and [0012](0012-structured-transaction-failure-error-model.md), and supersedes parts of [0014](0014-two-primitive-split-and-scope-robustness.md). The disposition tickets #37, #38 and #39 are measured against it. It changes no code. The execution effort that follows the map does that.

## Context

The engine was over-built in directions that did not advance reach. `REQUIRES_NEW` deepened the engine and blocks drivers that cannot draw a second connection. `Result`-first deepened it and raised the adoption wall that every framework adapter has to tunnel back through. The seven-variant error union adds a matching duty to every consumer. The README and `CONTEXT.md` describe the product by Spring parity, which names the depth axis as the headline.

The packages are 0.x (core 0.3.0, nestjs 0.2.0) and the author is the only known consumer.

## Decision

### 1. Headline promise

`@drizzle-tx` v1 gives the Drizzle apps people actually run implicit transaction propagation. A user wraps a unit of work once, and every query in its call tree joins one transaction with no `tx` passing. Spring's `@Transactional` stays as an analogy in the body for readers who know it. It is not the promise. Propagation modes and typed errors are capabilities that serve the promise.

### 2. Reach is the yardstick

Reach has two axes. Framework reach comes first: NestJS today, then tRPC, Next.js Server Actions, and Hono, Fastify and Express recipes. Driver reach comes second: node-postgres, Neon WebSocket and postgres.js first. MySQL and SQLite are seam-ready and not in v1. Ticket #40 picks the first win.

### 3. Drop-in test

An app has adopted the library with no rewrite only if all three hold.

1. No repository signature changes. Repositories keep taking or injecting a plain Drizzle `db`.
2. The app's error handling is untouched. Code that throws, or returns its own error type, keeps working.
3. One assembly call, `createDrizzleTx({ drizzle })` or the NestJS module, plus wrapping units of work. The user writes no per-framework glue.

The acceptance check is one question. Could a stock Next, tRPC or NestJS Drizzle app adopt the library by changing only its `db.ts` and its transaction call sites?

### 4. The depth-vs-breadth rule

A capability enters the **default surface** only if it meets both clauses.

- It works on every supported driver and framework adapter.
- A user can adopt the library without knowing it exists.

Anything else is opt-in and capability-gated. It must not shape the adapter port, the assembly path, or the default error contract. Four amendments make the rule mechanical.

1. **Sufficiency.** The clauses are necessary. An item is IN only if it is also needed for the headline or the drop-in test. Without this, `NESTED`, `./testing` and `begin()` enter by default.
2. **"Supported" means configuration, anchored to the reach roadmap.** It does not mean driver and it does not mean today's test matrix. `REQUIRES_NEW` works on a `pg.Pool` and fails on a `pg.Client`, which is the same driver in two configurations.
3. **The adoption act is exempt.** Each adapter's wrap point is that adapter's spelling of `withTransaction`. This covers `withTransaction`, `@Transactional`, the tRPC middleware and the Server Action HOF. Read literally, "every framework adapter" would demote them.
4. **OPT-IN and OUT are defined.** OPT-IN means built, gated, and touching nothing in the port, the assembly or the default error contract. OUT means unbuilt or against the headline. Each OUT item names one invariant v1 keeps so it can land later without a break.

### 5. The v1 surface

| Class | Items |
|---|---|
| IN | `withTransaction`, transactional client proxy, `createDrizzleTx`, adapter port (an internal seam), NestJS adapter, `@Transactional`, `REQUIRED`, `NESTED`, and each framework adapter when built |
| OPT-IN | `./testing` adapters |
| OUT of v1 | `begin()` and `await using`, post-commit hooks, retry on 40001 and 40P01, OpenTelemetry, outbox, escaped-write warning, transaction timeout, named connections |
| PENDING | `REQUIRES_NEW` (#37), the `Result` contract (#38), the seven-variant error union (#39) |

The smallest set that passes the drop-in test is `createDrizzleTx`, the proxy, `withTransaction`, `REQUIRED` and the port. NestJS adds its module. `NESTED` and `@Transactional` are IN without being minimal.

Four classifications were contested and are decided here.

- `NESTED` is IN. Savepoints work on every v1 driver, and gating it would add an optional port member for no user.
- `@Transactional` is IN. Its defect is the `Result`-only typing of ADR-0005, which #38 decides, not its existence.
- `begin()` is cut. It fails drop-in criterion 1, has no flagship consumer, and bypasses `planTransaction` when it opens a second connection inside an active transaction.
- `./testing` is OPT-IN. It is a separate subpath that nobody needs in order to adopt.

The OUT items are unbuilt and none is needed for the drop-in test. Escaped-write is the first to revisit, because it guards the main silent failure of a drop-in install. It cannot be exact without patching the user's own client, so it stays out.

### 6. Invariants that bind #37, #38 and #39

These hold under every outcome of the pending tickets. Each ticket's ADR must meet them or name the one it breaks.

- The adapter port stays `Result`-free. It is `Promise<T>` and throw-based today.
- The throw to `Result` translation lives in `rollback-boundary.ts` only.
- No assembly-time error-mode flag exists. The losing convention ships as a separately named function or subpath.
- The default `withTransaction` overloads typecheck with the `Independent` overloads deleted. `settle` and `Independent` are not needed to write `REQUIRED` code.
- `createDrizzleTx` never requires a pool and never rejects a non-pool client (ADR-0010 §2).
- The port never builds or returns a `DrizzleTxError`.
- A variant reachable only through a non-default path is never a required arm of the default `matchError`.
- Retry and OTel classify by predicate, never by exhaustive switch.
- Assembly failures stay outside the union (ADR-0010 §3).

### 7. Framework adapters

An adapter adds a wrap point and a bridge to its host's native error convention. It never adds engine behavior. Each adapter is a thin wrapper over `createDrizzleTx`.

### 8. No compatibility layer

The packages are 0.x and the author is the only known consumer. The execution effort changes the public API directly, with no deprecation shims and no compatibility states. It migrates the one known consumer, Billy's Garage, deliberately.

### 9. No separate tickets for concept count or audit unwinding

Concept count falls out of the dispositions. The surface drops `begin()`, and #37 to #39 shrink modes, `Result` and the taxonomy. If the surface still feels heavy after they land, #40 can add a ticket. Output of the closed audits #20 to #24 that fails the amended rule goes onto the ledger below. It is not re-litigated.

## Violations ledger

The code breaks this surface today. The execution effort fixes each item. Nothing here is fixed by this ADR.

1. `classifyRollback` turns a thrown app error into `err(TransactionAborted)`, so a NestJS exception filter never sees it. This breaks drop-in criterion 2 and belongs to #38.
2. Core bundles `pg`. `adapters/drizzle.ts` imports it at the top level, `pg` is only a devDependency, and `dist/index.js` is about 169 kB with node-postgres inlined. This taxes every non-node-postgres user.
3. `createDrizzleTx` returns `begin` and `manager` and accepts `disposeTimeoutMs`, which shapes the one assembly call.
4. The NestJS module provides the proxy only under `DRIZZLE_TX_CLIENT`. Repositories that inject the app's own DB token must change, which breaks drop-in criteria 1 and 3.
5. `HostNotInitialized.connectionName` is a dead stub in the default error union.
6. The port requires `supportsIndependentTransactions` and `wrapWithNestedTransaction`. The first belongs to #37. The second stays, because `NESTED` is IN.

Two further defects were found and are unverified. `isPoolBacked` very likely returns false for postgres.js, whose `$client` is a function. `begin()` on a single `pg.Client` may commit the outer transaction.

## Consequences

- ADR-0014 is superseded for `begin()` (E1) and `disposeTimeoutMs` (R5). The callback primitive stands.
- ADR-0011 §1 is wrong about the code. The port does not speak `Result`. Its claim that `Result` is the core contract is contingent on #38.
- ADR-0002, 0003, 0005, 0009 and 0012 are contingent on #37, #38 and #39. Each ticket's ADR amends them.
- ADR-0010 and 0013 are consistent. ADR-0013's observer must not become an assembly option.
- The README opening and the `CONTEXT.md` intro name Spring parity. The execution effort rewrites them to match §1.
- `docs/drizzle-tx/session-1.md` lists hooks, retry and escaped-write as "Do Now". Ticket #40 supersedes that ordering in `session-2.md`.
