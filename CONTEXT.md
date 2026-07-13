# @drizzle-tx

A framework-agnostic Drizzle ORM transaction manager built on Node `AsyncLocalStorage`, with a NestJS adapter. It gives Spring-`@Transactional`-style implicit transaction propagation so the transaction handle never has to be prop-drilled.

## Language

### Clients & transactions

**Base client**:
The pool-backed root Drizzle instance — used outside any transaction and to start new top-level transactions.
_Avoid_: base db, root db, fallback instance, default db

**Active transaction** (`tx`):
The Drizzle transaction (or savepoint) handle for an in-flight unit of work, stored in `AsyncLocalStorage`.
_Avoid_: transaction client, tx instance, active client

**Transactional client**:
The injectable `Proxy` that transparently resolves each call to the **active transaction** if one exists, else the **base client**. This is the single handle repositories inject.
_Avoid_: tx-aware client, proxy client, managed client, injectable db

**Connection**:
A physical `pg` pool connection. A pooling/infrastructure concern, distinct from an **active transaction** (which is bound to one connection for its lifetime).
_Avoid_: using "connection" to mean the client or the transaction

### Engine

**Transaction manager**:
The framework-agnostic core engine (`@drizzle-tx/core`) — owns the `AsyncLocalStorage`, the propagation switch, and rollback handling.

**Adapter**:
The ORM seam the manager talks to (`wrapWithTransaction` / `wrapWithNestedTransaction` / `getBaseClient`). The v1 production implementation is the Postgres `DrizzleAdapter` (async-only); a second `NoOpDrizzleAdapter` (from `@drizzle-tx/core/testing`) runs work against a caller-supplied client with no real transaction, and records the boundaries it enters, for tests (ADR-0007).

**Assembly** (`createDrizzleTx`):
The single non-DI factory that wires a **base client** into a ready-to-use `{ db, withTransaction, begin, isActive, manager }` — the one canonical path every surface (NestJS today, tRPC/Next next) builds on so defaults can't drift. Unlike the fallible runtime surface, assembly **throws at construction** on a fatal misconfiguration (a driver that cannot host an interactive transaction — Neon HTTP); this is a boot-time programmer error, not a modeled runtime condition, so it is exempt from the never-throw rule (ADR-0003).
_Avoid_: builder, container, factory (bare)

**Transaction host**:
The NestJS-facing facade — the imperative `withTransaction()` API plus DI wiring; registers itself in a static registry so `@Transactional` can find it at call time.

**Propagation**:
How a transactional method relates to an already-active transaction. v1 modes: **REQUIRED** (join or start), **REQUIRES_NEW** (independent new top-level transaction on its own connection), **NESTED** (savepoint within the current transaction).

**Callback primitive** (`withTransaction(work)`):
The default, flagship way to run a transaction — a callback with **implicit** propagation: the **transactional client** auto-joins the active transaction (via the `AsyncLocalStorage` context). Rollback-via-`err`.

**Scope primitive** (`begin()` / `await using`):
The advanced escape hatch — a block-scoped handle (`TransactionScope`, rollback-unless-`commit()`) with **explicit** propagation: you query through `scope.tx`; the **transactional client** does NOT auto-join (a scope sets no ALS context — `enterWith` is forbidden, ADR-0001). An opt-in `disposeTimeoutMs` leak backstop reclaims a forgotten scope (ADR-0014 R5).
_Avoid_: calling the scope a "manual transaction" — it is the **scope primitive**.

### Errors

**`DrizzleTxError`**:
The library's exhaustive discriminated union of *infrastructure* failures (`PoolConnectionTimeout`, `TransactionAborted`, `HostNotInitialized`, `NotPoolBacked`). A consumer's own domain error `E` is never folded into this union — it is returned faithfully.
_Avoid_: mixing domain errors into `DrizzleTxError`

## Relationships

- A **Transaction manager** holds one `AsyncLocalStorage` and delegates to one **Adapter**.
- The **Adapter**'s `getBaseClient()` returns the **base client**; `wrapWithTransaction` starts a new **active transaction**.
- The **Transactional client** resolves to the **active transaction** if present, else the **base client** — repositories never know which.
- A **Transaction host** wraps a **Transaction manager** for NestJS; `@Transactional` looks it up and runs the method through it.
- **REQUIRES_NEW** consumes an *additional* **connection** from the pool for the lifetime of its **active transaction** (see ADR-0002).

## Example dialogue

> **Dev:** "In a `NESTED` block, does the repository get a different **transactional client**?"
> **Maintainer:** "No — the **transactional client** is the same injected `Proxy`. Inside `NESTED` it resolves to a savepoint **active transaction**; the repository code is identical. Only `REQUIRES_NEW` runs on a separate **connection**."

## Flagged ambiguities

- "client" / "db" / "tx" / "connection" were used interchangeably during design — resolved to four distinct terms: **base client**, **active transaction**, **transactional client**, **connection**.
- "fallback instance" (from prior-art nestjs-cls) is the **base client** here; the adapter method is named `getBaseClient()`.
