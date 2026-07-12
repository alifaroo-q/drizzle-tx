# @drizzle-tx/core

The framework-agnostic transaction engine behind [`@drizzle-tx`](https://github.com/) — a Spring-`@Transactional`-style implicit transaction manager for [Drizzle ORM](https://orm.drizzle.team/) built directly on Node's `AsyncLocalStorage`. No web-framework dependency; adapters (NestJS first) layer on top.

Ships **ESM + CJS** with an explicit `Result` model — it never throws for modeled conditions.

## Install

```bash
pnpm add @drizzle-tx/core drizzle-orm pg
```

`drizzle-orm` is an **optional** peer (the engine uses only structural types).

## What's in the box

- `createDrizzleTx({ drizzle })` — the single canonical assembly path: wires the manager + adapter + transactional client and returns `{ db, withTransaction, begin, isActive, manager }`. Throws `UnsupportedDriverError` at construction for a driver that can't host interactive transactions (Neon HTTP). See [`createDrizzleTx`](#createdrizzletx--the-canonical-assembly-path) below.
- `TransactionManager` — the `AsyncLocalStorage` engine + the `REQUIRED` / `REQUIRES_NEW` / `NESTED` propagation switch, plus rollback-via-`err`. `withTransaction(work)` is the callback/ALS path; `begin()` returns an `await using` scope (`TransactionScope`, rollback-unless-`commit()`).
- `DrizzleAdapter` — the async `node-postgres` adapter (`wrapWithTransaction` / `wrapWithNestedTransaction` / `getBaseClient`), with Pool-backed detection and pool-timeout → `PoolConnectionTimeout` mapping.
- `createTransactionalClient(resolve)` — a transparent `Proxy` that resolves each access to the currently-active transaction (or the base client), binding methods to the real instance so private-field access works.
- `Result<T, E>` (`Ok<T>` / `Err<E>`) + `ok` / `err` / `isOk` / `isErr` / `assertNever` — the thin, dependency-free Result type.
- Result combinators — `map`, `mapErr`, `andThen`, `unwrapOr`, `match` (standalone, tree-shakable functions; consumers depend only on the `Result` *type*).
- `DrizzleTxError` — the exhaustive infrastructure-error union (`PoolConnectionTimeout`, `TransactionAborted`, `HostNotInitialized`, `NotPoolBacked`), plus `DrizzleTxErrorKind` and the exhaustive `matchError(e, handlers)`.
- `Propagation`, `TxOptions` (`IsolationLevel` / `AccessMode`), `TxLogger`, and the `TransactionAdapter<TClient>` seam.

## Usage

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  TransactionManager,
  DrizzleAdapter,
  createTransactionalClient,
  Propagation,
  ok,
  err,
} from '@drizzle-tx/core';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const base = drizzle({ client: pool, relations });

const manager = new TransactionManager(new DrizzleAdapter({ db: base }));

// Inject THIS anywhere a Drizzle client is expected — it auto-joins the active transaction.
const db = createTransactionalClient(() => manager.getTransactionClient());

const result = await manager.withTransaction(async () => {
  await db.insert(users).values({ name: 'Ada' });
  return ok(null); // returning err(...) rolls back
});

// Independent nested transaction on its own pooled connection:
await manager.withTransaction(Propagation.RequiresNew, async () => {
  await db.insert(auditLog).values({ event: 'signup' });
  return ok(null);
});
```

Or scope-based via explicit resource management (rolls back unless `commit()` — note a scope uses `scope.tx` explicitly and does **not** set the ALS context):

```ts
const opened = await manager.begin();
if (!opened.ok) return opened;                          // infra error as a value
await using scope = opened.value;
await scope.tx.insert(users).values({ name: 'Ada' });
scope.commit();                                          // omit → rollback on scope exit
```

### `createDrizzleTx` — the canonical assembly path

The wiring above (manager + adapter + transactional client) collapses into one factory. Every surface (the NestJS adapter today; tRPC / Next next) builds on it, so defaults can't drift between them:

```ts
import { createDrizzleTx } from '@drizzle-tx/core';
import { drizzle } from 'drizzle-orm/node-postgres';

export const { db, withTransaction, begin, isActive, manager } = createDrizzleTx({
  drizzle: drizzle({ client: pool, relations }),
});
// `db` is the transactional client (auto-joins the active tx) — import it in repositories.
```

**Driver matrix** — an interactive transaction needs a real TCP connection, so the adapters are **Node-runtime only** (edge can't open a pg pool; ADR-0009):

| Driver | Interactive tx / `REQUIRES_NEW` |
|---|---|
| node-postgres `pg.Pool` | ✅ full — primary target |
| neon-serverless (WebSocket Pool) | ✅ full — serverless-friendly |
| **neon-http** | ❌ **hard-unsupported** — `createDrizzleTx` throws `UnsupportedDriverError` at construction |
| PgBouncer / Supavisor *transaction* mode | ⚠️ `REQUIRED` works with `prepare:false`; `REQUIRES_NEW` draws a 2nd pooled backend → double connection pressure |

Neon HTTP is one-shot / non-interactive — switch to `drizzle-orm/neon-serverless` (WebSocket) for transactions. The gate fails fast and clearly at assembly rather than mysteriously at the first query (ADR-0010).

## Building a new adapter

Implement `TransactionAdapter<TClient>` for another ORM/driver and hand it to `TransactionManager`. The engine owns the ALS context and propagation; the adapter only knows how to start a top-level transaction, start a savepoint, and return the base client.

See the repository root README for the propagation table, the controller-boundary pattern, and the Pool-sizing/deadlock notes.

## License

MIT © Ali Farooq
