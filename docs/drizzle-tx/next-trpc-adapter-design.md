# Design: Next.js + tRPC framework adapters (flagship — Massive #1)

Date: 2026-07-12 | Status: design settled, de-risked, not yet built | Decisions: [ADR-0009](../adr/0009-framework-adapters-node-only-and-result-throw-bridge.md)

Realizes the stated raison d'être — a framework-agnostic core that backs adapters beyond NestJS ([drizzle-tx-v1.0-prd.md:14](../prds/drizzle-tx-v1.0-prd.md)). Escapes the NestJS-only ceiling by shipping the two highest-demand non-Nest surfaces (tRPC, then Next.js Server Actions), on the primitives core already has.

## Why this is low-effort/high-leverage

Core is **already framework-agnostic**. The engine — `TransactionManager.withTransaction` (the ALS-entering primitive, [transaction-manager.ts:37-58](../../packages/core/src/transaction-manager.ts#L37-L58)), `TransactionContext` (pure `node:async_hooks`, [transaction-context.ts](../../packages/core/src/transaction-context.ts)), and `createTransactionalClient` (a DI-free Proxy over a `resolve()` thunk, [transactional-client.ts](../../packages/core/src/transactional-client.ts)) — has zero NestJS coupling. The NestJS module ([drizzle-transaction.module.ts:63-79](../../packages/nestjs/src/drizzle-transaction.module.ts#L63-L79)) is ~10 lines of wiring around it. For Next/tRPC there's no DI and no decorators, so the adapters are **thinner still**: a module-singleton manager + ergonomic wrappers + conventions. This is packaging + conventions + one de-risked bridge, not a new engine.

## Package layout

```
@drizzle-tx/core           ← ADD createDrizzleTx({ db }) — the non-DI canonical assembly path
   returns { db, withTransaction, isTransactionActive, begin, manager }
   • collapses the raw `new TransactionManager(new DrizzleAdapter({ db }))` + createTransactionalClient dance
   • the SINGLE assembly path: NestJS module refactors to delegate to it (defaults can't drift)
   • every non-Nest surface (tRPC, Next, future Hono/Fastify/Express) builds on this

@drizzle-tx/trpc           ← peer: @trpc/server (v11). NOT Next-specific — tRPC runs standalone/Express/Fastify too
   txMiddleware / txProcedure factory; per-procedure (batch-safe); unwrap→TRPCError bridge

@drizzle-tx/nextjs         ← peer: next (v16). Server Actions + Route Handlers
   transactional(actionFn, opts?) HOF (returns Result); Route Handler helper; compose-under-next-safe-action recipe
```

**Why the split** (vs one `@drizzle-tx/next`): tRPC isn't Next-specific — a `@drizzle-tx/trpc` with only a `@trpc/server` peer is reusable on Express/Fastify/standalone. `createDrizzleTx` in core makes the generic request-middleware for Hono/Fastify/Express a ~5-line recipe (docs/examples first, tiny packages later — the rest of Massive #1). Cost: two subpaths/packages to `publint`/`attw`.

## API surfaces

### core — `createDrizzleTx`

```ts
// db.ts — construct ONCE as a module singleton
import { createDrizzleTx } from '@drizzle-tx/core';
import { drizzle } from 'drizzle-orm/node-postgres';

export const { db, withTransaction, begin, isTransactionActive, manager } = createDrizzleTx({
  drizzle: drizzle({ client: pool, relations }),
});
// `db` is the transactional client (auto-joins the active tx); import it in repositories.
```

The NestJS module is refactored so its `DRIZZLE_TX_MANAGER`/`DRIZZLE_TX_CLIENT` providers wrap a `createDrizzleTx({ drizzle })` result instead of hand-constructing the manager — one canonical factory, provably consistent surfaces.

### `@drizzle-tx/trpc` — per-procedure middleware (confirmed by spike, see ADR-0009)

```ts
import { createTxMiddleware } from '@drizzle-tx/trpc';
import { manager } from './db';

const txMiddleware = createTxMiddleware(t, manager);   // t = your initTRPC instance
export const txProcedure = t.procedure.use(txMiddleware);

// usage — each procedure runs in its own transaction; batched calls do NOT merge
export const appRouter = t.router({
  transfer: txProcedure.input(schema).mutation(async ({ input }) => {
    await db.update(...); await db.update(...);   // both in one tx; throw/err → rollback
    return { ok: true };
  }),
});
```

- Drives commit/rollback from `next().ok`; **no throw for domain errors**; infra `DrizzleTxError` → `TRPCError`.
- **Rule (documented loudly): never open the tx in `createContext`** — batch-merge hazard (ADR-0009).
- Accepts propagation/options: `createTxMiddleware(t, manager, { propagation: 'REQUIRES_NEW' })` or a per-procedure variant.

### `@drizzle-tx/nextjs` — Server Action HOF (returns `Result`)

```ts
import { transactional } from '@drizzle-tx/nextjs';
import { ok, err } from '@drizzle-tx/core';
import { manager } from '@/db';

export const placeOrder = transactional(manager, async (input: OrderInput) => {
  const order = await db.insert(orders).values(input).returning();
  if (soldOut) return err({ kind: 'SoldOut' } as const);
  return ok(order);                       // ok commits, err rolls back
});
// placeOrder(input): Promise<Result<Order, { kind: 'SoldOut' } | DrizzleTxError>>
```

- Returns core's `Result` (consistent with `@Transactional`/`withTransaction`; serializable across RSC; typed errors survive to the client). Escape hatch: `transactional(manager, fn, { throwOnErr: true })` → `Promise<T>`, throws on `err`.
- **Compose under next-safe-action / zsa** (for users already on those libs): `.use(({ next }) => manager.withTransaction(() => next()))`.
- Route Handler helper: a thin `withTransaction`-wrapper for `app/api/**/route.ts`.

## Runtime, drivers, serverless (→ ADR-0009)

- **Node runtime only** for transactions (edge can't open a pg pool; ALS-on-edge is irrelevant). Docs: `export const runtime = 'nodejs'` (the Next 16 default).
- **Driver gate:** `pg.Pool` ✅ · Neon **WebSocket** Pool ✅ · Neon **HTTP** ❌ (hard-unsupported — detect & fail clearly) · PgBouncer txn-mode ⚠️ (`prepare:false`; `REQUIRES_NEW` doubles backend pressure).
- **Next.js 16 caveats** (docs, not design): never run a tx inside `"use cache"`; request-context reads are async-only; Turbopack default → keep `pg`/`@drizzle-tx/*` server-only; don't stretch a tx into `after()` or a streamed boundary.

## Build order

1. **`createDrizzleTx` in core** — tiny, unblocks everything; refactor NestJS module to delegate to it (proves the shared-factory consistency).
2. **`@drizzle-tx/trpc`** — the `.use()` seam is well-defined and the bridge is de-risked (spike GREEN); ship first, it's the higher-confidence win.
3. **`@drizzle-tx/nextjs`** — Server Action HOF + Route Handler helper (more convention choices, now decided).
4. **Example app** — Next 16 App Router + tRPC v11 + Drizzle (Postgres) — proof + best docs; exercises the `"use cache"`/`after()` caveats.
5. **(Later) generic Hono/Fastify/Express middleware** — ~5-line recipes on `createDrizzleTx`; docs first.

## Decisions (settled)

- Package layout: `createDrizzleTx` in core + separate `@drizzle-tx/trpc` + `@drizzle-tx/nextjs`.
- Server Action HOF returns core's `Result` (not next-safe-action/zsa shapes); `throwOnErr`/`.orThrow()` escape hatch.
- tRPC bridge driven by `next().ok`, per-procedure middleware, infra-only `TRPCError` (de-risked via spike, ADR-0009).
- Node-runtime-only; edge unsupported for tx; Neon-HTTP hard-unsupported (ADR-0009).
- `createDrizzleTx` is the single assembly path; NestJS refactors onto it.

## Open (pre-build)

- Exact `createTxMiddleware` signature ergonomics (curry `t` then `manager`, or one call) — settle in the tRPC package spike/impl.
- `DrizzleTxError` → tRPC code mapping table (`PoolConnectionTimeout` → `SERVICE_UNAVAILABLE`? others → `INTERNAL_SERVER_ERROR`) — finalize in impl.
- Whether the Route Handler helper is worth a distinct export vs just documenting `withTransaction` usage.
