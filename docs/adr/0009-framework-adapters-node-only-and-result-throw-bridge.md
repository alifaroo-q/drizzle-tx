# Framework adapters are Node-runtime-only and bridge `Result`↔throw per host surface

**Status: Proposed (forward-looking).** Records the two cross-cutting decisions for the non-NestJS framework adapters (`@drizzle-tx/trpc`, `@drizzle-tx/nextjs`) — the flagship "escape the NestJS-only ceiling" work (session-1.md Massive #1). Design detail lives in [next-trpc-adapter-design.md](../drizzle-tx/next-trpc-adapter-design.md); this ADR fixes the two load-bearing boundaries. Both decisions are backed by a live code spike and triangulated web research (2026-07-12).

## Decision 1 — the transactional feature is Node-runtime-only; edge is unsupported for transactions

`AsyncLocalStorage` *is* available on the Vercel Edge runtime (WinterCG subset) and Cloudflare Workers (`nodejs_compat`), so ALS is not the constraint. But an interactive Postgres **transaction needs a real connection pool over TCP**, which the edge/V8-isolate runtime cannot open. Therefore the adapters target the **Node.js runtime** (the default in Next.js 16) and document edge as unsupported for transactions.

Driver capability is a hard gate, not guidance:

| Driver | Interactive tx / `REQUIRES_NEW` |
|---|---|
| `pg.Pool` (Node server) | ✅ full — primary target |
| `drizzle-orm/neon-serverless` (Neon **WebSocket** Pool) | ✅ full — the serverless-friendly path |
| `drizzle-orm/neon-http` (Neon **HTTP**) | ❌ **hard-unsupported** — one-shot, non-interactive; no interactive multi-statement tx, no 2nd concurrent connection |
| PgBouncer / Supavisor *transaction* mode | ⚠️ `REQUIRED` works with `prepare:false`; `REQUIRES_NEW` is semantically correct but draws a 2nd pooled backend → double connection pressure |

The Neon-HTTP `❌` is load-bearing: Neon-HTTP + Vercel is a very common Drizzle stack, and it fundamentally cannot host our interactive transactions. The adapter must detect and fail clearly, not mysteriously. `REQUIRES_NEW` pool-sizing/deadlock caveats from [ADR-0002](0002-requires-new-needs-pool-and-can-deadlock.md) apply unchanged on the supported drivers.

**Next.js 16 confirms the approach** (GA Oct 2025, 16.2.x, React 19.2, Node ≥ 20.9): Node runtime remains the default; no per-Server-Action interception hook was added (the HOF wrapper is still the only seam); Node ≥ 20.9 clears the `Symbol.asyncDispose` floor (≥ 20.4) the `begin()` scope needs. Three Next-16 docs caveats attach to the adapter, not the design: (1) **never run/join a transaction inside a `"use cache"` function** — the opt-in `cacheComponents`/`"use cache"` model decouples cached execution from the request, so an ALS scope established outside is not guaranteed visible inside; keep tx scopes in request-time code (Server Actions, Route Handlers, dynamic Server Components); (2) request-context reads (`cookies()`/`headers()`/`params`) are async-only — relevant only if a future named-connection selector reads a header; (3) Turbopack is the default bundler — consumers keep `pg`/native deps server-only via `turbopack.resolveAlias` (or `--webpack`). Also: don't stretch a tx scope into `after()` (stabilized in 15.1) or across a streamed/suspended boundary — treat those as new scopes.

## Decision 2 — `Result`↔throw is bridged per host surface (the "split bridge"), never by imposing one convention on both

Core never throws for modeled conditions (`Result<T,E>`, ADR-0003). The host surfaces disagree on error convention: **tRPC throws `TRPCError`** (caught by its `errorFormatter`); **Server Actions / next-safe-action / zsa return typed objects/tuples**. Imposing `Result` on tRPC would force `if (!res.ok) throw` boilerplate in every procedure; imposing throw on Server Actions would discard the never-throw win on the surface whose ecosystem expects returned objects. So we **match each host** and keep core's invariant intact underneath.

### tRPC surface — driven by `next().ok`, not by catching throws

A **live spike against `@trpc/server` 11.18** established the mechanics empirically:
- `await next()` does **not** throw on a downstream error — it returns tRPC's own Result-shaped `MiddlewareResult`: `{ ok: true, data, marker, ctx }` or `{ ok: false, error, marker }`. tRPC catches the resolver's throw (both `TRPCError` and plain `Error`) and normalizes it into that object.
- **Returning** the `ok:false` result from middleware surfaces the error to the caller faithfully (`NOT_FOUND` stayed `NOT_FOUND`; a plain `Error` surfaced as `INTERNAL_SERVER_ERROR`).
- Commit/rollback is therefore driven by `next().ok` **with no throw from us** for domain errors.

Confirmed middleware shape:

```ts
const txMiddleware = t.middleware(async ({ next }) => {
  let mw;                                    // tRPC's MiddlewareResult
  const res = await manager.withTransaction(async () => {
    mw = await next();
    return mw.ok ? ok(mw) : err(mw);         // map tRPC outcome → our commit/rollback signal
  });
  if (res.ok) return res.value;              // committed → return the MiddlewareResult
  if (mw)     return mw;                      // domain rollback → tRPC's own errored result (faithful)
  throw txErrorToTRPC(res.error);            // infra-only → DrizzleTxError → TRPCError
});
```

Two facts the spike pinned:
- **Return the `next()` result object, never unwrapped data** — tRPC stamps it with an internal `marker` it validates.
- **On the tRPC surface the domain error is already tRPC-shaped** (normalized inside `next()` before our middleware sees it), so core's "return `E` faithfully" yields to tRPC's `errorFormatter` here — correct least-surprise for tRPC users. The Server Action surface keeps the faithful `Result`.

The transaction lives in **per-procedure middleware, never in `createContext`**: `httpBatchLink` packs many calls into one HTTP request and `createContext()` runs once per request (shared), but middleware runs once per procedure — a context-level tx would silently merge unrelated batched operations into one transaction on one connection. Middleware-level tx gives each batched call its own independent transaction. This is the single most important adapter rule and is documented loudly.

### Server Action surface — return the `Result`

`transactional(actionFn)` returns core's `Result<T, E | DrizzleTxError>` — the same `Result` the user already returns from `@Transactional` methods and `withTransaction`. Within *this* library, consistency beats matching a foreign convention: next-safe-action's `{ data, serverError }` folds the typed error union into a string (destroying the exhaustive discriminated match of ADR-0003/0005); a `[data, err]` tuple loses the named shape. A `Result` is a plain serializable object, so it crosses the RSC boundary and keeps typed errors on the client. Escape hatches: `{ throwOnErr: true }` / `.orThrow()` for the error-boundary style, and a documented recipe to compose *under* next-safe-action/zsa's `.use()` (`.use(({ next }) => withTransaction(() => next()))`) for users already invested there.

## Consequences / constraints

- Adapters ship as **Node-runtime-only**; docs state `export const runtime = 'nodejs'` (the default) and edge-unsupported-for-tx prominently, plus the driver matrix above.
- The two surfaces have **deliberately different return conventions** — tRPC throws `TRPCError` at its boundary; Server Actions return `Result`. This asymmetry is intentional (host least-surprise), documented, not a leak.
- `DrizzleTxError` → tRPC code mapping is a new small surface (`txErrorToTRPC`): infra variants → `INTERNAL_SERVER_ERROR` (or `SERVICE_UNAVAILABLE` for `PoolConnectionTimeout`), with the original in `cause`. Consumer domain `E` is never mapped by us on the Server Action path (returned faithfully); on the tRPC path it has already passed through tRPC's formatter.

## Rejected alternatives

- **Support edge for transactions.** Rejected: edge can't open a Postgres TCP pool; the only edge DB path (Neon-HTTP) can't do interactive transactions. ALS being edge-available doesn't help.
- **One error convention across both surfaces** (`Result` everywhere, or throw everywhere). Rejected: `Result` everywhere forces per-procedure throw boilerplate in tRPC; throw everywhere discards the never-throw win on Server Actions where the ecosystem returns objects. Split bridge matches each host.
- **Open the tRPC transaction in `createContext`.** Rejected: shared once-per-request context + `httpBatchLink` would merge unrelated batched operations into one transaction. Per-procedure middleware instead.
- **Return next-safe-action's `{ data, serverError }` / zsa's `[data, err]` from the Server Action HOF.** Rejected: both discard the typed `Result` union that is core's identity; offered instead as a compose-under recipe for users already on those libs.

## Evidence

Live spike: `@trpc/server` 11.18 middleware `next()` returns a Result-shaped `MiddlewareResult`; returning an `ok:false` result surfaces the error at the caller; commit/rollback driven without throwing for domain errors (scratch spike, 2026-07-12). Web research (triangulated, primary sources, 2026-07-12): Vercel edge `async_hooks` WinterCG subset + no TCP; Neon HTTP non-interactive vs WebSocket interactive; tRPC `createContext` once-per-request + per-procedure middleware (trpc.io v11 docs); next-safe-action `{data|serverError|validationErrors}`; Next.js 16 Node-default runtime, no new action-interception hook, `"use cache"` model, async request APIs, Turbopack default (nextjs.org blog + upgrade guide, Oct 2025–May 2026).
