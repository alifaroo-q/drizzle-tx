# Spec: adapter-author API surface — exported `WithTransaction<TClient>` + a deliberate export list (E4 + E5)

Resolves issue [#32](https://github.com/alifaroo-q/drizzle-tx/issues/32) (audit-03 gaps **E4** + **E5**). Deliverable per the wayfinder map [#19](https://github.com/alifaroo-q/drizzle-tx/issues/19): **the spec** — the exported adapter-author type + the deliberate `@drizzle-tx/core` export surface. **The build is execution** (co-sequenced with the [#31 `Independent` brand](../prototypes/independent-brand.md) impl — see §0).

Design forks decided HITL (#32, prototype ticket):

- **E4 shape:** `WithTransaction<TClient>` = **indexed alias off `TransactionManager`** — zero-drift, brand lives in one place.
- **Error factories:** export **all four** as adapter-author API.
- **Surface tiering:** **single entry point**, explicit named exports grouped into an app-dev tier and an adapter-author tier by JSDoc + section comments (no second subpath).
- **`assertNever`:** **drop** from the public surface (and from nestjs's re-export barrel).

This is the base every framework adapter (Next.js / tRPC / Hono) builds on. Audit-03 §Part 5 is the source: the one real adapter — nestjs `TransactionHost` — had to **re-declare all four `withTransaction` overloads + an `as (...args: unknown[]) =>` cast**, and the `export *`-based surface silently widens on any module addition and leaks `assertNever`.

---

## §0 — Co-sequencing with the #31 brand (read first)

The [#31 `Independent<T,E>` brand](../prototypes/independent-brand.md) is **adopted but not yet in code**. It changes the `withTransaction` overload set: the `'REQUIRES_NEW'` **literal** overload returns `Promise<Independent<T, E | DrizzleTxError>>`; every other form returns plain `Promise<Result<T, E | DrizzleTxError>>`. Because E4 is an **indexed alias** off the manager (§1), the branded overload set lives in exactly one place — the manager class — and `WithTransaction` follows automatically.

**Therefore this spec is written against the *target* (branded) manager overloads (§1.1), and E4 + the #31 brand impl land together as one execution unit.** Do not ship `WithTransaction` against the current (unbranded) overloads — it would be born stale.

The export list (§2) likewise includes the #31-introduced symbols — `Independent`, `settle`, and the brand-modified `TransactionWork` — since #32 (E5) is exactly where their public classification is decided (the E4↔E5 merge point: both answer "what may an adapter author touch").

---

## §1 — E4: exported `WithTransaction<TClient>`

### 1.1 The target (branded) manager overloads

Execution updates `TransactionManager.withTransaction`'s overload set to fold in the #31 brand. The `'REQUIRES_NEW'` literal splits out of the general `Propagation` overloads:

```ts
// no-propagation (implicit REQUIRED) → plain Result
withTransaction<T, E>(work: TransactionWork<T, E>): Promise<Result<T, E | DrizzleTxError>>;

// REQUIRES_NEW literal → Independent brand (an inner that settled on its OWN connection)
withTransaction<T, E>(
  propagation: 'REQUIRES_NEW',
  work: TransactionWork<T, E>,
): Promise<Independent<T, E | DrizzleTxError>>;
withTransaction<T, E>(
  propagation: 'REQUIRES_NEW',
  options: TxOptions,
  work: TransactionWork<T, E>,
): Promise<Independent<T, E | DrizzleTxError>>;

// other propagation modes → plain Result (savepoint / join semantics; return inner is fine)
withTransaction<T, E>(
  propagation: Propagation,
  work: TransactionWork<T, E>,
): Promise<Result<T, E | DrizzleTxError>>;
withTransaction<T, E>(
  options: TxOptions,
  work: TransactionWork<T, E>,
): Promise<Result<T, E | DrizzleTxError>>;
withTransaction<T, E>(
  propagation: Propagation,
  options: TxOptions,
  work: TransactionWork<T, E>,
): Promise<Result<T, E | DrizzleTxError>>;
```

**Overload order matters:** the `'REQUIRES_NEW'`-literal overloads must precede their general `Propagation` counterparts, so a literal `'REQUIRES_NEW'` argument resolves to the `Independent` return before the wider `Propagation` overload matches. (`Independent<T,E> = Result<T,E> & { readonly [IND]: true }`, so the literal overloads are strict refinements — safe to list first.)

### 1.2 The exported type — indexed alias

```ts
// core/index.ts (adapter-author tier)

/**
 * The `withTransaction` call-signature contract, for adapter authors wrapping the manager.
 * Reference this instead of re-declaring the overloads: it preserves all six overloads
 * (incl. the REQUIRES_NEW `Independent` brand) and the `Result<T, E | DrizzleTxError>`
 * union, and it can never drift from the engine because it is indexed off it.
 *
 * @example An adapter exposes `withTransaction` as a bound field, not a re-declared method:
 *   readonly withTransaction: WithTransaction<MyClient> =
 *     this.manager.withTransaction.bind(this.manager);
 */
export type WithTransaction<TClient> = TransactionManager<TClient>['withTransaction'];
```

This is the **proven** `DrizzleTx` pattern (`create-drizzle-tx.ts` already types `readonly withTransaction: TransactionManager<TClient>['withTransaction']`, guarded by `create-drizzle-tx.test-d.ts` — overloads survive `.bind`). E4 names it and exports it.

### 1.3 What adapter-authors do with it

An adapter that today re-declares the overloads collapses to a **single bound field**:

```ts
// BEFORE (nestjs TransactionHost — the pattern every adapter copies):
withTransaction<T, E>(work: TransactionWork<T, E>): Promise<Result<T, E | DrizzleTxError>>;
withTransaction<T, E>(propagation: Propagation, work: TransactionWork<T, E>): Promise<...>;
withTransaction<T, E>(options: TxOptions, work: TransactionWork<T, E>): Promise<...>;
withTransaction<T, E>(propagation: Propagation, options: TxOptions, work): Promise<...>;
withTransaction<T, E>(a, b?, c?): Promise<Result<T, E | DrizzleTxError>> {
  return (this.#manager.withTransaction as (...args: unknown[]) => Promise<...>)(a, b, c);
}

// AFTER — a bound field typed by the exported contract. No re-declaration, no cast:
readonly withTransaction: WithTransaction<unknown> =
  this.#manager.withTransaction.bind(this.#manager);
```

A `readonly` field holding a bound function is a valid `@Injectable` member — DI is unaffected. The `as (...args: unknown[]) =>` cast disappears because there is no variadic implementation body to reconcile.

### 1.4 Consequence — nestjs `TransactionHost` refactor (in-scope; mechanical)

Per the map's "**`@drizzle-tx/nestjs` changes beyond mechanical updates forced by a core-seam change** are out of scope" boundary, this **is** an in-scope mechanical update: replace the four re-declared overloads + variadic impl + cast in `packages/nestjs/src/transaction-host.ts` with the bound field above. The type-level guarantee is unchanged (still `Independent`-aware once #31 lands). This refactor is the **acceptance witness** for E4: if `WithTransaction<unknown>` cannot re-type the host without re-declaring overloads, E4 has failed.

### 1.5 Rejected — standalone call-signature interface

A hand-written `interface WithTransaction<TClient> { <T,E>(...): ...; ... }` was rejected: it re-states the six branded overloads, **re-introducing the very drift E4 exists to kill** (it would need a `*.test-d.ts` asserting equivalence to the manager method to stay honest). Adapters already type against `TransactionManager` as a type import, so the indexed alias adds no new coupling. Decoupling from the class is not worth duplicating the contract.

---

## §2 — E5: the deliberate export surface

Convert every `export *` in `packages/core/src/index.ts` to **explicit named re-exports**, grouped into two tiers by section comment + JSDoc. Adding an export to a module no longer silently widens the public contract — the widening is now an explicit edit to `index.ts` (and a `check:publish` / API-review surface).

### 2.1 The two tiers

Single entry point (`@drizzle-tx/core`); **no** `./adapter` subpath (the two audiences share most of the surface — `Result`, `DrizzleTxError`, `TxOptions`, `Propagation` — so a physical split would force double re-exports). The tiers are documentation, enforced by grouping + JSDoc `@` markers, not module boundaries.

**Tier A — app-developer API** (the happy path a repository/handler author imports):

| Symbol | Module | Notes |
|---|---|---|
| `createDrizzleTx`, `CreateDrizzleTxOptions`, `DrizzleTx` | `create-drizzle-tx` | assembly |
| `Result`, `Ok`, `Err`, `ok`, `err`, `isOk`, `isErr` | `result` | the contract |
| `map`, `mapErr`, `andThen`, `unwrapOr`, `match` | `result` | combinators (E2: kept, docs-only) |
| `Independent`, `settle` | `result` | **#31** — inspect a REQUIRES_NEW outcome; `settle()` to propagate |
| `DrizzleTxError`, `DrizzleTxErrorKind`, `DrizzleTxErrorHandlers`, `matchError` | `errors` | error model + exhaustive match |
| `Propagation` | `propagation` | value + type |
| `TxOptions`, `IsolationLevel`, `AccessMode` | `options` | tx options |
| `TxLogger`, `noopLogger`, `consoleLogger` | `logger` | injectable logger + provided impls |
| `TransactionScope` | `transaction-scope` | `await using` scope (type only) |
| `TransactionWork` | `propagation-plan` (via manager) | the unit of work (brand-modified by #31) |
| `UnsupportedDriverError` | `driver-capability` | assembly throw (ADR-0010) |
| `DrizzleAdapterConfig`, `DrizzleTxCapable` | `adapters/drizzle` | driver typing |

**Tier B — adapter-author API** (building a framework adapter over core):

| Symbol | Module | Notes |
|---|---|---|
| `WithTransaction` | `index` (§1.2) | **E4** — the overload contract to reference |
| `TransactionManager`, `TransactionManagerOptions` | `transaction-manager` | the engine an adapter wraps |
| `TransactionAdapter` | `adapters/port` | the port a driver adapter implements |
| `DrizzleAdapter` | `adapters/drizzle` | the built-in adapter |
| `createTransactionalClient` | `transactional-client` | the tx-aware proxy factory |
| `poolConnectionTimeout`, `transactionAborted`, `hostNotInitialized`, `notPoolBacked` | `errors` | **error factories** — construct a `DrizzleTxError` (see §2.2) |

JSDoc every Tier-B symbol with an `@remarks Adapter-author API` line so hover/docs signal "advanced / not the happy path" (mirrors the audit-03 `manager`-escape-hatch note → E7).

### 2.2 Error-factory classification — export all four

`poolConnectionTimeout`, `transactionAborted`, `hostNotInitialized`, `notPoolBacked` all move from `export *` to explicit Tier-B exports.

- **`hostNotInitialized`** has a **proven cross-package consumer**: nestjs's `@Transactional` decorator returns `err(hostNotInitialized(undefined))` when the host isn't wired.
- The other three are today only produced by **core internals** (propagation-plan / rollback-boundary) and consumed by core tests.

Decided (HITL): **export all four** as adapter-author API. Rationale — they are the constructors for the **public** `DrizzleTxError` type; a future Next/tRPC adapter mirroring nestjs's "not initialized" path (or any adapter surfacing an infra failure as a value) needs at least `hostNotInitialized`, and exporting 1-of-4 constructors for one type is arbitrary asymmetry. Cost of the extra three is a few lines of surface for a frozen, exhaustive union. (If a future audit finds them genuinely inert, dropping the three internal-only factories is a clean pre-1.0 narrowing.)

### 2.3 `assertNever` — drop from the public surface

`assertNever` (in `result.ts`) is today public via `export *` **and re-exported by nestjs's barrel** (`packages/nestjs/src/index.ts`, bundled into "the Result/propagation surface"). Decided (HITL): **drop it from both public surfaces.**

- It is an **internal exhaustiveness helper**. App-devs matching a `DrizzleTxError` already have `matchError` (expression-form exhaustiveness, ADR-caught on new variants); a transaction library exporting a *generic* `assertNever` is scope creep.
- **Execution actions:** (a) remove `assertNever` from `core/index.ts`'s explicit exports (it stays exported from `result.ts` for **intra-package** use — propagation-plan and the `*.test-d.ts` guards import it directly from `../../src/result.js`, unaffected); (b) remove `assertNever` from `packages/nestjs/src/index.ts`'s re-export list.
- This is a **pre-1.0 breaking change** to nestjs's barrel — acceptable (rides the pre-1.0 window, like the E7 renames), and it is the in-scope "nestjs change forced by a core-seam change."

### 2.4 The resulting `index.ts` (shape)

```ts
// ─── Tier A: app-developer API ────────────────────────────────────────────────
export { createDrizzleTx, type CreateDrizzleTxOptions, type DrizzleTx } from './create-drizzle-tx.js';
export {
  type Result, type Ok, type Err, ok, err, isOk, isErr,
  map, mapErr, andThen, unwrapOr, match,
  type Independent, settle,               // #31
} from './result.js';
export {
  type DrizzleTxError, type DrizzleTxErrorKind, type DrizzleTxErrorHandlers, matchError,
} from './errors.js';
export { Propagation } from './propagation.js';
export { type TxOptions, type IsolationLevel, type AccessMode } from './options.js';
export { type TxLogger, noopLogger, consoleLogger } from './logger.js';
export type { TransactionScope } from './transaction-scope.js';
export type { TransactionWork } from './transaction-manager.js';
export { UnsupportedDriverError } from './driver-capability.js';
export { type DrizzleAdapterConfig, type DrizzleTxCapable } from './adapters/drizzle.js';

// ─── Tier B: adapter-author API ───────────────────────────────────────────────
/** @remarks Adapter-author API. The overload contract to reference when wrapping the manager. */
export type WithTransaction<TClient> = TransactionManager<TClient>['withTransaction'];
export { TransactionManager, type TransactionManagerOptions } from './transaction-manager.js';
export type { TransactionAdapter } from './adapters/port.js';
export { DrizzleAdapter } from './adapters/drizzle.js';
export { createTransactionalClient } from './transactional-client.js';
export {
  poolConnectionTimeout, transactionAborted, hostNotInitialized, notPoolBacked,
} from './errors.js';

// NOT exported (internal): assertNever (result.ts) — use matchError for DrizzleTxError.
```

`assertNever` is the **only** symbol previously reachable via `export *` that is now withheld. Everything else in `errors`/`result`/`logger`/`options`/`propagation`/`adapters/port` was already legitimately public; E5's win is that the surface is now **enumerated** (no silent widening) and **tiered** (the adapter-author seam is signposted).

---

## §3 — Verification (execution)

The spec is realized when execution can assert:

1. **E4 acceptance witness** — `packages/nestjs/src/transaction-host.ts` re-types `withTransaction` as `readonly withTransaction: WithTransaction<unknown> = this.#manager.withTransaction.bind(this.#manager)` with **no** re-declared overloads and **no** `as (...args: unknown[])` cast, and the existing nestjs type-level + integration tests still pass.
2. **Overload + brand preservation** — a `*.test-d.ts` asserts `WithTransaction<X>` carries all six overloads: the `'REQUIRES_NEW'` literal call yields `Independent<…>`; every other form yields plain `Result<…>`; the domain-error channel does not collapse (extend the existing `create-drizzle-tx.test-d.ts` assertions).
3. **`assertNever` withheld** — a type-level check that `assertNever` is **not** importable from `@drizzle-tx/core` (`@ts-expect-error` on the package import), while still importable from `./src/result.js` intra-package.
4. **No silent widening** — `check:publish` (`publint --strict` + `attw`) passes against the enumerated surface; there is no remaining `export *` in `core/index.ts`.

## §4 — Not in this spec (execution / out of scope)

- **The #31 brand implementation itself** (adding `Independent`/`settle`/the phantom to `TransactionWork` and re-shaping the manager overloads) — execution, co-sequenced with E4 (§0).
- **E7 naming nits** (`isActive`→`isTransactionActive`, option-key `drizzle`, `manager` label, `match`/`matchError`) — execution backlog; the `@remarks Adapter-author API` JSDoc here partially addresses the `manager`-escape-hatch signal.
- **Dropping the three internal-only error factories** — deliberately **kept** for symmetry (§2.2); revisit only if a later audit finds them inert.
- **A `./adapter` subpath** — rejected (§2.1); revisit only if the adapter-author surface grows enough to warrant physical isolation.
