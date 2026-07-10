# CLAUDE.md

Guidance for agents/maintainers working in this repo. Read `CONTEXT.md` (terminology), `docs/prds/`, and `docs/adr/` for the source of truth on behavior and naming.

## What this is

A pnpm monorepo shipping Spring-`@Transactional`-style implicit Drizzle transaction propagation on Node `AsyncLocalStorage`.

- **`packages/core` (`@drizzle-tx/core`)** — framework-agnostic engine. Owns the ALS context, the `REQUIRED`/`REQUIRES_NEW`/`NESTED` propagation switch, rollback handling, the `TransactionAdapter` seam, the async `DrizzleAdapter`, the tx-aware `Proxy`, and the `Result`/`DrizzleTxError` model. **Dual ESM+CJS via tsdown.** Zero runtime dependency on any web framework.
- **`packages/nestjs` (`@drizzle-tx/nestjs`)** — NestJS 11 adapter. Module + `TransactionHost` + `@Transactional` + injectable transactional client. **CJS-only, built with `tsc`** (needs legacy decorators + `emitDecoratorMetadata`).
- **`test/` (repo root), `vitest.*.ts`** — shared real-Postgres harness only (`schema.ts`, Testcontainers, database-per-worker). Package-level tests live under each package (see Layout).

### Layout (core)

`packages/core/src` is **flat** — one file per module — with a single `adapters/` folder (`port.ts`, `drizzle.ts`, `noop.ts`) for the one seam with multiple implementations. This is deliberate: a ~1500 LOC single-purpose library has *one* feature (it *is* the feature), so feature-vertical-slice folders don't apply — mature focused libraries (effect, tanstack query-core, zustand, drizzle core) stay flat and folderize only a *repeating unit* (drivers/adapters) or a *second published surface* (`./testing`). **Do not re-introduce feature-slice folders (`propagation/`, `engine/`, …) or move tests back into `src`.** Core's own tests live in `packages/core/test/{unit,types,integration}/` (kept out of `src` so the build/`rootDir` sees source only); the Vitest `core-unit`/`core-integration` globs and the root `tsconfig.test.json` integration glob point there.

`packages/nestjs/src` is likewise flat with **no folders** — it's a thin single-implementation adapter over core, so there's no seam to fold out (`./testing` is its one extra published surface). Its tests live in `packages/nestjs/test/{unit,integration,types}/`, split by whether they touch Postgres: `unit/` (`*.test.ts` — DI/decorator-metadata, CJS-resolution, and no-op-adapter tests that bootstrap Nest but hit no DB) and `integration/` (`*.integration.test.ts` — real-Postgres). **Both nestjs projects still need the SWC transform** (every nestjs test uses decorators); the split is only about `globalSetup`. So there are TWO Vitest projects with TWO configs, sharing the SWC plugin via `vitest.shared.ts`: `nestjs-unit` (`vitest.unit.config.ts`, no `globalSetup`) and `nestjs-integration` (`vitest.config.ts`, Testcontainers `globalSetup`). Both keep `pool: 'forks'` — the process-global `TransactionHost` registry must be isolated per file (ADR-0004; `transactional-host-miss` asserts an *empty* registry). Root `tsconfig.test.json` globs `packages/*/test/integration/**/*.integration.test.ts` (harness typecheck); nestjs `unit/` tests are typechecked by the package's own `tsconfig.json` (`include: ["src", "test"]`).

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
- **Pool detection is structural, not just `instanceof`** (`adapters/drizzle.ts` `isPoolBacked`). `$client instanceof pg.Pool` fails across duplicated `pg` module instances (ESM/CJS interop, or the test harness loading built dist alongside source), so there's a `totalCount`/`idleCount` structural fallback.
- **`composite: true` + `tsc -p`:** the nestjs build is `rimraf dist tsconfig.tsbuildinfo && tsc -p ...`. Because the base config is `composite` (needed for the root `tsc -b`), a stale `tsconfig.tsbuildinfo` makes `tsc -p` skip emit after `rimraf dist`. The build must clear the tsbuildinfo too.
- **Type-level tests** (`*.test-d.ts`) are excluded from the package `tsconfig.json` (so they don't hit the build) and checked via a dedicated `tsconfig.test-d.json` wired into each package's `typecheck` script. This is where the ADR-0005 `@Transactional` guard, the `DrizzleTxError` exhaustiveness, and `matchError`'s exhaustiveness are enforced.
- **`erasableSyntaxOnly` (core):** no constructor parameter properties (`constructor(readonly x)`); use an explicit field + assignment.
- **Build before typecheck:** `@drizzle-tx/nestjs` typechecks against `@drizzle-tx/core`'s built `dist/*.d.ts` (resolved via its `exports` map), so **core must be built before nestjs typechecks** — `pnpm typecheck` on a clean tree needs a prior `pnpm build` (CI runs `build` before `typecheck` for this reason). The root `typecheck` uses `tsc -b --noEmit` so it never clobbers tsdown's bundled `dist`.
- **nestjs test files: per-package editor config, NOT project references.** `packages/nestjs/test/**/*.integration.test.ts` are excluded from the emit build but must still be typechecked with `experimentalDecorators` (legacy 3-arg decorators). The editor (tsserver) assigns each file to the *nearest* `tsconfig.json`; if that config *excludes* the file, the file lands in an inferred project with no `experimentalDecorators` and `@Transactional` fails with **editor-only TS1241** ("runtime will invoke the decorator with 2 arguments, but the decorator expects 3"). The root `tsconfig.test.json` fixes the CLI typecheck but tsserver never reads it (it only discovers `tsconfig.json`). The fix is the `tsconfig.json` (editor: `noEmit`, `moduleResolution: bundler`, `include: ["src", "test"]`) + `tsconfig.build.json` (emit: `node16`, `include: ["src"]`) split in `packages/nestjs` — the editor config must include `test/` so tsserver still owns the relocated test files. **Do NOT "fix" this with a composite test project + project references** (the canonical TS pattern): it's genuinely unworkable here because `@drizzle-tx/core` is tsdown-built (one bundled `index.d.ts`, not per-file composite `tsc` output) → a reference into it fails **TS6305**, and the load-bearing `tsc -b --noEmit` typecheck can't have a composite leaf reference emit-enabled projects → **TS6310**. `moduleResolution: bundler` on the editor config (not node16) is intentional: the tests statically import the ESM harness while the package is `"type": "commonjs"`, which node16 flags **TS1479** — but vitest/SWC bundles them, so bundler mode models their real runtime. Emit stays strict `node16` in `tsconfig.build.json`.
- **`await using` scope API (`begin()`):** core `tsconfig` adds `lib: ["…","ESNext.Disposable"]` for `AsyncDisposable`/`Symbol.asyncDispose`. The scope bridges the adapter's *callback*-scoped transaction to a *block* scope via a gate promise (the work callback parks until dispose). It deliberately does **not** touch ALS (that needs a callback; `enterWith` is forbidden), so `scope.tx` is explicit and the injected proxy won't auto-join. Rollback is default-deny; dispose never throws (settle failures are logged). Needs `Symbol.asyncDispose` at runtime (Node ≥ 20.4).
- **Test project wiring:** the root `core-*` Vitest projects glob **only** `packages/core/**`. All nestjs tests run under the two nestjs projects (`nestjs-unit` + `nestjs-integration`, both SWC — see Layout). Never glob nestjs files into a core project — the plain (non-SWC) transform strips decorator metadata. `pnpm test:nestjs` runs both nestjs projects.

## Publishing / release

Both packages publish from CI (`.github/workflows/release.yml`, on push to `main` + `workflow_dispatch`) via `changesets/action` using **npm OIDC trusted publishing** — **no `NPM_TOKEN`, no OTP in CI**, and provenance (SLSA + npm publish attestation) auto-attaches. Steady state: `pnpm changeset` → commit/push → merge the auto-opened "Version Packages" PR → CI publishes. (To skip the PR: run `pnpm changeset version` locally and push the bump — the action publishes once no changeset files remain.)

- **OIDC cannot do a package's *first* publish** (chicken-and-egg: npm requires the package to exist before a trusted publisher / provenance can attach — `POST /-/package/<pkg>/trust` 404s otherwise; see npm/cli#8544). So each package's **initial** version was published **manually with an OTP** (`pnpm changeset publish` locally; account 2FA is `auth-and-writes`). Every version after that goes through CI OIDC. A brand-new package's packument also has propagation lag — `npm view`/trust can 404/400 for a few minutes right after that first publish; wait it out.
- **Trusted publisher is configured in the npmjs.com web UI**, per package: package → Settings → Trusted Publisher → GitHub Actions, org `alifaroo-q`, repo `drizzle-tx`, workflow `release.yml`, no environment. **The `npm trust` CLI (npm 11.13) 400s** against the registry even with valid auth — use the web UI, don't fight the CLI.
- **Provenance requires `repository.url` in each published `package.json`** to match the building repo, else publish fails `E422 - Failed to validate repository information: "repository.url" is ""`. Both manifests carry `repository` (with `directory`), `homepage`, `bugs` — **do not remove them.** (A local OTP publish skips provenance, so it won't catch a missing `repository` — only the CI OIDC publish will.)
- **The Release workflow is gated (`gate` job) so non-release pushes skip publishing.** Under OIDC (no auth token), `changeset publish`'s pre-check `npm info` concludes nothing is published, so it tries to **re-publish already-live versions**; pnpm publish returns `E403 "cannot publish over the previously published version"`, and `@changesets/cli@2.31.0`'s `isAlreadyPublishedError` **crashes** classifying it — it reads `json.error.summary`, which pnpm/bun don't set (they use `json.error.message`), so `undefined.includes(…)` throws instead of skipping. This is upstream **changesets/changesets#2099**, fixed by **PR #2132 but only released on the `3.0.0-next` prerelease line** — stable `latest` (2.31.0) still crashes, and we won't adopt a prerelease major. So the `gate` job decides *from git alone* (pending `.changeset/*.md`, or a `+  "version":` diff in `packages/*/package.json`) whether the push can produce a release, and skips the `release` job otherwise — no npm reads, immune to the staleness. If a stable changesets ships the fix, the gate stays as belt-and-suspenders (harmless). Any published version is intact regardless; this was only ever cosmetic-red on docs/chore pushes.

## ALS / propagation notes

- **Functional core / imperative shell (ADR-0006).** Core is split by effect: **pure** decision modules — `propagation-plan.ts` (`planTransaction` → a `TxPlan` value; `normalizeArgs`) and `rollback-boundary.ts` (`toThrowable`/`classifyRollback`, the `throw`↔`Result` translation) — plus **effect** modules `transaction-context.ts` (the ALS wrapper) and `transaction-scope.ts` (the `await using` gate bridge). `transaction-manager.ts` is a thin coordinator: snapshot ALS → `planTransaction` → interpret the `TxPlan`. When adding logic, put decisions in the pure modules (unit-testable, no DB) and keep effects in the shell. Adding a `TxPlan`/`DrizzleTxError` variant is compile-caught at every `assertNever`.
- **Adapter port is callback-style, not mutation-style.** `wrapWithTransaction(options, work)` / `wrapWithNestedTransaction(parent, work)` hand the tx/savepoint client *to* `work`; the manager enters `TransactionContext.run(tx, …)` inside that callback, so the ALS store is immutable from construction (no `setClient`, no in-place `client` reassignment). Store presence == active; there is no `active` flag.
- The manager uses `AsyncLocalStorage.run()` (never `enterWith()`) to avoid context leakage.
- `REQUIRES_NEW` draws a *fresh* pooled connection while the parent holds its own → pool `max` must exceed the deepest concurrent nesting depth or it deadlocks. A finite `connectionTimeoutMillis` makes exhaustion fail fast as `err(PoolConnectionTimeout)` (ADR-0002).
- `@Transactional` resolves `TransactionHost` from a process-global registry (a method decorator has no DI access) → one app per process per connection name (ADR-0004). Vitest `forks` isolates each test file's process, so DB-per-worker parallelism is unaffected.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues on `alifaroo-q/drizzle-tx` via the `gh` CLI. Two accounts are logged in — run `gh auth switch --user alifaroo-q` before any `gh` operation here. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
