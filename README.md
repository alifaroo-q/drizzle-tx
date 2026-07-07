# @drizzle-tx

Spring-`@Transactional`-style implicit transaction propagation for [Drizzle ORM](https://orm.drizzle.team/), built on Node's `AsyncLocalStorage`. The active transaction is carried implicitly through the async call tree, so the transaction handle never has to be prop-drilled into your repositories.

- **`@drizzle-tx/core`** — a framework-agnostic engine (ALS + propagation switch + an ORM adapter seam). Ships ESM + CJS.
- **`@drizzle-tx/nestjs`** — a NestJS 11 adapter: a module, an injectable transactional client, an imperative `TransactionHost`, and a `@Transactional` decorator.

Everything is built on an **explicit `Result` model**: the library never throws for modeled conditions. Fallible operations return `ok(value)` or `err(error)`; `err` is the rollback signal.

## Install

```bash
pnpm add @drizzle-tx/nestjs @drizzle-tx/core drizzle-orm pg
```

`@drizzle-tx/core` lists `drizzle-orm` as an **optional** peer (the engine uses only structural types). The NestJS adapter needs `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, and `rxjs` (standard NestJS peers).

> **Postgres + Pool required.** v1 targets the async `node-postgres` driver and the base `db` **must be `Pool`-backed** (see [Limitations](#limitations)).

## Quick start (NestJS)

**1. Register the module** with your Pool-backed Drizzle instance:

```ts
import { Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DrizzleTransactionModule } from '@drizzle-tx/nestjs';
import { relations } from './schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const db = drizzle({ client: pool, relations });

@Module({
  imports: [DrizzleTransactionModule.forRoot({ drizzle: db })],
})
export class AppModule {}
```

`forRootAsync({ inject, useFactory })` is available when the `db` comes from another provider.

**2. Inject the transactional client** in repositories. It is a transparent `Proxy` that resolves to the active transaction if one exists, else the base client — repositories never know which:

```ts
import { Injectable, Inject } from '@nestjs/common';
import { DRIZZLE_TX_CLIENT } from '@drizzle-tx/nestjs';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { users } from './schema';

@Injectable()
export class UserRepo {
  constructor(@Inject(DRIZZLE_TX_CLIENT) private readonly db: NodePgDatabase<typeof relations>) {}

  create(name: string) {
    return this.db.insert(users).values({ name }).returning();
  }
}
```

**3. Wrap a unit of work.** Either the imperative `TransactionHost` or the `@Transactional` decorator. Both return a `Result` and never throw:

```ts
import { Injectable } from '@nestjs/common';
import { Transactional, ok, err, type Result, type DrizzleTxError } from '@drizzle-tx/nestjs';

@Injectable()
export class BillingService {
  constructor(private readonly users: UserRepo, private readonly accounts: AccountRepo) {}

  // The method's error union MUST include DrizzleTxError (compiler-enforced — see ADR-0005).
  @Transactional()
  async signup(name: string): Promise<Result<number, 'DUPLICATE' | DrizzleTxError>> {
    const [u] = await this.users.create(name);
    await this.accounts.open(u.id);
    return ok(u.id); // commits; returning err(...) rolls back
  }
}
```

## Propagation

`@Transactional(mode)` / `host.withTransaction(mode, work)` control how a unit of work relates to an already-active transaction. v1 ships three modes:

| Mode | No active transaction | Inside an active transaction |
| --- | --- | --- |
| `Propagation.Required` *(default)* | Starts a new top-level transaction | **Joins** it — no new `BEGIN`; a propagated `err` rolls back the whole thing |
| `Propagation.RequiresNew` | Starts a new top-level transaction | Starts an **independent** transaction on a **separate pooled connection** — commits/rolls back on its own, regardless of the outer |
| `Propagation.Nested` | Starts a new top-level transaction | Opens a **SAVEPOINT** — an inner `err` rolls back only to the savepoint; the outer can still commit |

Isolation/access-mode `TxOptions` apply only when **starting a new top-level transaction**; they are ignored (with a warning) when joining or opening a savepoint.

## Controllers are the throw boundary

Services return `Result`; **controllers** unwrap it and are the only place a throw happens — exhaustively matching `err` to an `HttpException`. `assertNever` makes the match compile-time exhaustive: add a `DrizzleTxError` variant and every controller stops compiling until it handles it.

```ts
import { Controller, Post, Body, ConflictException, ServiceUnavailableException, InternalServerErrorException } from '@nestjs/common';
import { isOk, assertNever } from '@drizzle-tx/nestjs';

@Controller('users')
export class UserController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  async signup(@Body('name') name: string) {
    const result = await this.billing.signup(name);
    if (isOk(result)) return { id: result.value };

    const e = result.error;
    if (e === 'DUPLICATE') throw new ConflictException('user already exists');

    // e is now DrizzleTxError — matched exhaustively.
    switch (e.kind) {
      case 'PoolConnectionTimeout':
        throw new ServiceUnavailableException('database busy, retry');
      case 'TransactionAborted':
        throw new InternalServerErrorException('transaction aborted');
      case 'HostNotInitialized':
        throw new InternalServerErrorException('transaction host not ready');
      case 'NotPoolBacked':
        throw new InternalServerErrorException('REQUIRES_NEW needs a Pool-backed db');
      default:
        return assertNever(e);
    }
  }
}
```

## Imperative API

```ts
const result = await host.withTransaction(async () => {
  await repo.create('a');
  await repo.create('b');
  return ok(2);
});
// host.withTransaction(Propagation.RequiresNew, work) and (options, work) overloads exist too.
```

`host.tx` exposes the current active-transaction client; `host.isTransactionActive()` reports whether one is open.

## Self-invocation works

Unlike interceptor-based approaches, `@Transactional` uses a method `Proxy`, so a method calling **another decorated method on `this`** (e.g. a `REQUIRES_NEW` audit) still gets its own transaction — no need to route through a separate provider.

## Limitations

- **Pool-backed base `db` required** (ADR-0002). `REQUIRES_NEW` opens a genuinely independent transaction by drawing a *fresh* pooled connection while the parent still holds its own — impossible on a single `pg.Client`. If the base db is not `Pool`-backed, `REQUIRES_NEW` returns `err(NotPoolBacked)`.
- **Pool sizing / deadlock.** Pool `max` **must exceed** the deepest concurrent `REQUIRES_NEW` nesting depth, or a child waits forever on a connection the parent won't release. Set a finite `connectionTimeoutMillis` (node-postgres defaults to `0` = wait forever); the library maps an acquisition timeout to `err(PoolConnectionTimeout)` so exhaustion **fails fast instead of hanging**.
- **Never throws for modeled conditions** (ADR-0003). `ok` commits, `err` rolls back and is returned faithfully, an unexpected throw becomes `err(TransactionAborted)`. Adopt the Result-at-the-service-layer, throw-at-the-controller convention.
- **Single app per process, per connection name** (ADR-0004). The decorator resolves its `TransactionHost` via a process-global registry; two Nest apps in one process sharing a connection name is unsupported in v1.
- **Out of scope in v1:** `SUPPORTS` / `NOT_SUPPORTED` / `MANDATORY` / `NEVER` propagation; MySQL / SQLite / sync drivers; lifecycle hooks; named/multiple connections; non-NestJS adapters. The seams for all of these exist.

## License

MIT © Ali Farooq
