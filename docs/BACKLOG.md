# Backlog

Deferred work, captured so the reasoning isn't lost. Nothing here is committed to a
release. Each item records **what**, **why deferred**, and the **prior art** we'd
piggyback on (mostly `.reference/nestjs-cls`, which has already paid these footgun costs).

Ordering is by rough leverage, not priority.

---

## E — Full propagation set (MANDATORY / NEVER / SUPPORTS / NOT_SUPPORTED)

**What.** Extend `Propagation` beyond v1's `REQUIRED` / `REQUIRES_NEW` / `NESTED` to the
full Spring/`nestjs-cls` set:

- `MANDATORY` — reuse the active tx; **reject** if none is active (pure assertion, cheap).
- `NEVER` — run with no tx; **reject** if one is active (pure assertion, cheap).
- `SUPPORTS` — join the active tx if present, else run with no tx.
- `NOT_SUPPORTED` — **suspend** the active tx and run the body non-transactionally,
  resuming the tx after.

**Why deferred.** `SUPPORTS` and `NOT_SUPPORTED` need a capability our core does **not**
have today: the ability to *run a scope with NO active transaction* while a parent tx
exists. `TransactionContext.run(client, fn)` always installs a client — there is no
"suspend / run-without-store". Adding this is an architectural seam (a
`TransactionContext.runWithout(fn)` that runs the callback with an empty ALS store) and
would be **ADR-worthy**. `MANDATORY` / `NEVER` are cheap (they only read `isActive()` and
return `err(...)`) and could ship independently of the suspend work.

**New error variants.** `MANDATORY`/`NEVER` need two new `DrizzleTxError` kinds
(e.g. `TransactionRequired`, `TransactionNotAllowed`) — each addition is compile-caught at
every `assertNever` (good) but is a breaking change to the exhaustive union.

**Prior art.**
- `.reference/nestjs-cls/packages/transactional/src/lib/propagation.ts` — the enum + the
  `TransactionAlreadyActiveError` / `TransactionNotActiveError` assertion errors.
- `.reference/nestjs-cls/packages/transactional/src/lib/transaction-host.ts`
  `decidePropagationAndRun` — the full truth-table, including `withoutTransaction()` which
  is exactly the suspend primitive we lack.
- Their fixes we'd inherit for free: #167 (correct `NEVER` behavior), #196 ("do not reuse
  parent transaction context" — the suspend/clear must genuinely empty the store, not
  shadow it).

**Where our code changes.** `propagation.ts` (enum), `propagation-plan.ts` (`planTransaction`
truth-table — new `TxPlan` variants like `suspend` and `reject`), `transaction-manager.ts`
(interpret them), `transaction-context.ts` (`runWithout`), `errors.ts` (new variants).

---

## F — Sync-driver support (`better-sqlite3` et al.)

**What.** Support Drizzle drivers whose `db.transaction(cb)` callback is **synchronous**
(`better-sqlite3`, `bun-sqlite`, `expo-sqlite`, `sql-js`, `durable-sqlite`) in addition to
the async pg driver.

**Why deferred.** Contradicts our explicit **pg / async-only v1 scope** (CONTEXT.md,
ADR-0001, `DrizzleAdapter` is documented "async-only"). Sync drivers change two things:
the tx callback must be sync (no `await` in the `@Transactional` body), and sync drivers
**throw synchronously** on rollback rather than rejecting a promise — so the adapter must
`try/catch` and convert to `Promise.reject` to keep the `wrapWithTransaction: Promise<T>`
contract. This ripples into our `Result`/rollback-boundary translation, which currently
assumes an async throw path.

**Prior art.**
- `.reference/nestjs-cls/.../transactional-adapter-drizzle-orm/src/lib/transactional-adapter-drizzle-orm.ts`
  — the `transactionMode: 'auto' | 'sync' | 'async'` option, `resultKind === 'sync'`
  auto-detection, and the `syncRunTx` / `asyncRunTx` split with `Promise.resolve` /
  `Promise.reject` wrapping.
- `.reference/nestjs-cls/.../test/transactional-adapter-drizzle-orm-sync.spec.ts` — a full
  better-sqlite3 test matrix (T1–T4, nested savepoints, mode-resolution unit tests) we
  could port almost verbatim.

**Where our code changes.** A new sync-capable adapter (or a mode flag on `DrizzleAdapter`),
plus rollback-boundary handling for a synchronous throw. Pool/`REQUIRES_NEW` concerns
(ADR-0002) are moot for single-connection sqlite.

---

## H — Named / multiple connections (full implementation)

**What.** Let one app run several independent transaction domains — each a named connection
with its own `DrizzleAdapter` + `TransactionManager` + `AsyncLocalStorage`. API shape
(mirrors `nestjs-cls`):

```ts
DrizzleTransactionModule.forRoot({ drizzle: coreDb,      connectionName: 'core' })
DrizzleTransactionModule.forRoot({ drizzle: analyticsDb, connectionName: 'analytics' })

@Transactional('analytics', Propagation.Required)
@InjectTransactionalClient('analytics') private readonly tx: AnalyticsDb
```

Each named connection gets its own DI tokens (`DRIZZLE_TX_CLIENT_<name>`, …); the registry
keys `TransactionHost` by connection name; the decorator and inject helper take an optional
`connectionName`. The v1 groundwork is already in place: the registry is a `Map` and
`DrizzleTxError.HostNotInitialized` already carries a `connectionName` field.

**Production uses (why it earns its keep).**
1. **Two physical databases in one app** (modular monolith — `billing` DB + `catalog` DB).
   The single most common driver: without it, the second DB's writes silently run
   non-transactionally through its base client.
2. **Separate pools for QoS isolation** (same physical DB, a `web` pool vs a `jobs` pool).
   Directly bounds the ADR-0002 `REQUIRES_NEW` pool-exhaustion blast radius — a burst of
   background work drawing from the `jobs` pool can't starve request-handling connections.
3. **Primary + read-replica** — mutations on `primary`, consistent read-only snapshot
   transactions on `replica`.
4. **Migration / dual-write windows** — both DBs live and transactional within one request.

**Load-bearing caveat (must be documented, likely its own ADR).** **No distributed
transactions / no 2PC.** Two named connections = two *independent* transactions. Write to
`core` (commits) then `analytics` (fails) → `core` is already committed; there is no
cross-DB atomicity or rollback. Spring's `@Transactional` has the same limitation without a
JTA/XA manager, and `nestjs-cls` does not do 2PC either. Named connections mean "several
independent transaction domains in one process," **not** "one atomic tx across databases."

**Does NOT cover:** DB-per-tenant with *dynamic* tenants. The registry is keyed by a
**static** connection name resolved at bootstrap, not a runtime tenant id. Dynamic
connection resolution is a separate, larger feature.

**Why deferred.** Feature expansion, not v1 hardening — none of the uses is a correctness
gap, they're "when a real second-database consumer shows up" needs. Multiplies API + DI
token surface and needs its own integration tests and an ADR for the no-2PC boundary. The
v1 code was made *honest* (the always-missing `TransactionHost.get(connectionName)` param
was removed; ADR-0004 reworded) rather than left half-wired.

**Prior art.**
- `.reference/nestjs-cls/.../transaction-host.ts` — `getTransactionClsKey(connectionName)`,
  the `_instanceMap` keyed by connection symbol, `InjectTransactionHost(connectionName)`.
- `.reference/nestjs-cls/.../plugin-transactional.ts` — per-connection token minting
  (`getTransactionHostToken`, `getTransactionToken`) and per-plugin module registration.
- Changelog 2.1.0 (#114) "add support for multiple transactional adapters" — including the
  internals rework "each plugin gets its own module" (a wiring footgun they hit and fixed).

**Where our code changes.** `drizzle-transaction.module.ts` (accept `connectionName`, mint
per-connection tokens), `transaction-host.ts` (key registry + `get(connectionName)` back),
`transactional.decorator.ts` + `inject.ts` (optional `connectionName` param), `tokens.ts`
(token factories).

---

## Notes

- **G (no-op testing adapter)** is being addressed in the current grilling session.
- **H** above was *partially* actioned now: the v1 code was made honest to single-connection
  scope (see ADR-0004). Only the full multi-connection feature is deferred.
