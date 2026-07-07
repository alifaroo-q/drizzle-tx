# CLAUDE.md

Guidance for agents/maintainers working in this repo. Read `CONTEXT.md` (terminology), `docs/prds/`, and `docs/adr/` for the source of truth on behavior and naming.

## What this is

A pnpm monorepo shipping Spring-`@Transactional`-style implicit Drizzle transaction propagation on Node `AsyncLocalStorage`.

- **`packages/core` (`@drizzle-tx/core`)** — framework-agnostic engine. Owns the ALS context, the `REQUIRED`/`REQUIRES_NEW`/`NESTED` propagation switch, rollback handling, the `TransactionAdapter` seam, the async `DrizzleAdapter`, the tx-aware `Proxy`, and the `Result`/`DrizzleTxError` model. **Dual ESM+CJS via tsdown.** Zero runtime dependency on any web framework.
- **`packages/nestjs` (`@drizzle-tx/nestjs`)** — NestJS 11 adapter. Module + `TransactionHost` + `@Transactional` + injectable transactional client. **CJS-only, built with `tsc`** (needs legacy decorators + `emitDecoratorMetadata`).
- **`test/`, `vitest.*.ts`** — shared real-Postgres harness (Testcontainers, database-per-worker).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | Build both packages (`tsdown` for core, `tsc` for nestjs) |
| `pnpm typecheck` | `tsc -b` solution build + per-package `tsc --noEmit` (incl. `tsconfig.test-d.json` type-level tests) |
| `pnpm test` | All Vitest projects (unit + core-integration + nestjs) |
| `pnpm test:unit` | Core unit tests only (fake adapter, no DB) |
| `pnpm test:int` | Core real-Postgres integration tests (needs Docker) |
| `pnpm test:nestjs` | NestJS tests (SWC transform, real-Postgres) |
| `pnpm lint` / `pnpm lint:fix` | Biome check / autofix |
| `pnpm -r run check:publish` | `publint --strict` + `attw` for both packages |

Integration tests require a running Docker daemon (Testcontainers pulls `postgres:17-alpine`).

## Conventions

- **Explicit `Result`, never throw.** Every fallible public signature returns `Result<T, E>`. `ok` commits, `err` rolls back and is returned faithfully. The only internal `throw` is the rollback signal, caught at the same boundary. Consumer domain errors `E` are never folded into `DrizzleTxError`.
- **Exhaustive errors.** `DrizzleTxError` is a discriminated union matched with `assertNever`. Adding a variant is a compile-caught breaking change at every `switch`.
- **Naming** (`CONTEXT.md`): base client / active transaction / transactional client / connection are four distinct things. The adapter method is `getBaseClient()` — **not** "fallback instance".
- **core = tsdown/dual, nestjs = tsc/CJS.** Do not switch core to tsc or nestjs to a bundler — nestjs relies on `tsc`'s `emitDecoratorMetadata`.
- **Never add a runtime dependency on `nestjs-cls` or `@nestjs/*` in core** (ADR-0001). It's studied prior art in `.reference/`, not a dependency.

## Non-obvious gotchas (learned the hard way)

- **Drizzle rc.4 construction:** use `drizzle({ client: pool, relations })`. `drizzle(pool, { relations })` is **not** a valid overload — it destructures the Pool as a config object and silently builds a new empty pool (SASL auth failure). See `vitest.dbPerWorker.ts`.
- **Vitest 4 / Vite 8 + decorator metadata:** the nestjs Vitest config sets `oxc: false`. Vite 8 transforms TS with Oxc *before* `unplugin-swc` runs, stripping type annotations so SWC's `decoratorMetadata` emits `design:paramtypes` as `[undefined]` — breaking type-based (non-`@Inject`) DI. Disabling Oxc makes SWC the sole transformer.
- **Pool detection is structural, not just `instanceof`** (`drizzle-adapter.ts` `isPoolBacked`). `$client instanceof pg.Pool` fails across duplicated `pg` module instances (ESM/CJS interop, or the test harness loading built dist alongside source), so there's a `totalCount`/`idleCount` structural fallback.
- **`composite: true` + `tsc -p`:** the nestjs build is `rimraf dist tsconfig.tsbuildinfo && tsc -p ...`. Because the base config is `composite` (needed for the root `tsc -b`), a stale `tsconfig.tsbuildinfo` makes `tsc -p` skip emit after `rimraf dist`. The build must clear the tsbuildinfo too.
- **Type-level tests** (`*.test-d.ts`) are excluded from the package `tsconfig.json` (so they don't hit the build) and checked via a dedicated `tsconfig.test-d.json` wired into each package's `typecheck` script. This is where the ADR-0005 `@Transactional` guard, the `DrizzleTxError` exhaustiveness, and `matchError`'s exhaustiveness are enforced.
- **`erasableSyntaxOnly` (core):** no constructor parameter properties (`constructor(readonly x)`); use an explicit field + assignment.
- **Build before typecheck:** `@drizzle-tx/nestjs` typechecks against `@drizzle-tx/core`'s built `dist/*.d.ts` (resolved via its `exports` map), so **core must be built before nestjs typechecks** — `pnpm typecheck` on a clean tree needs a prior `pnpm build` (CI runs `build` before `typecheck` for this reason). The root `typecheck` uses `tsc -b --noEmit` so it never clobbers tsdown's bundled `dist`.
- **`await using` scope API (`begin()`):** core `tsconfig` adds `lib: ["…","ESNext.Disposable"]` for `AsyncDisposable`/`Symbol.asyncDispose`. The scope bridges the adapter's *callback*-scoped transaction to a *block* scope via a gate promise (the work callback parks until dispose). It deliberately does **not** touch ALS (that needs a callback; `enterWith` is forbidden), so `scope.tx` is explicit and the injected proxy won't auto-join. Rollback is default-deny; dispose never throws (settle failures are logged). Needs `Symbol.asyncDispose` at runtime (Node ≥ 20.4).
- **Test project wiring:** the root `core-*` Vitest projects glob **only** `packages/core/**`. All nestjs tests run under the `packages/nestjs` project (SWC). Never glob nestjs files into a core project — the plain transform strips decorator metadata.

## ALS / propagation notes

- The manager uses `AsyncLocalStorage.run()` (never `enterWith()`) to avoid context leakage.
- `REQUIRES_NEW` draws a *fresh* pooled connection while the parent holds its own → pool `max` must exceed the deepest concurrent nesting depth or it deadlocks. A finite `connectionTimeoutMillis` makes exhaustion fail fast as `err(PoolConnectionTimeout)` (ADR-0002).
- `@Transactional` resolves `TransactionHost` from a process-global registry (a method decorator has no DI access) → one app per process per connection name (ADR-0004). Vitest `forks` isolates each test file's process, so DB-per-worker parallelism is unaffected.
