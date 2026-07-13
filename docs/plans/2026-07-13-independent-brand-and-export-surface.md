# Independent Brand + Adapter-Author Export Surface (Plan C) — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use the repo's available execution skill when one exists (for example, `executing-plans` or `tdd`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the co-sequenced breaking unit: the #31 `Independent<T,E>` type-level brand (REQUIRES_NEW outcomes can't be `return`ed as an outer Result by accident; `settle()` is the conscious unwrap), plus the #32 adapter-author surface — export `WithTransaction<TClient>`, convert the `export *` surface to a deliberate two-tier named list, and drop `assertNever` from the public API.

**Architecture:** The brand is **purely type-level, zero runtime cost** — `Independent<T,E> = Result<T,E> & { [IND]: true }` (phantom `unique symbol`, never set); `settle` is an identity cast; `TransactionWork`'s return is poisoned with `{ [IND]?: never }` so a branded value fails to satisfy it (`true ⊄ never`) while `.ok`/`.value`/`.error` still read through. Only the `'REQUIRES_NEW'`-literal `withTransaction` overloads return `Independent`; every other form returns plain `Result`. E4 is an **indexed alias** off the manager (`WithTransaction<TClient> = TransactionManager<TClient>['withTransaction']`) so the branded overloads live in exactly one place and the alias can't drift. E5 enumerates the surface into an app-dev tier and an adapter-author tier (JSDoc-tagged), single entry point.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly`), Vitest 4, tsdown dual ESM+CJS (core) / tsc CJS (nestjs). The brand adds **no runtime code paths** — `pnpm test` behavior is unchanged; the whole plan is enforced by `pnpm typecheck` (incl. `*.test-d.ts`) + `check:publish`.

**Source of truth:** [Prototype+decision: Independent brand](../drizzle-tx/prototypes/independent-brand.md) (#31) and [Spec: adapter-author API surface](../drizzle-tx/specs/adapter-author-api-surface.md) (#32). The proven indexing pattern: `create-drizzle-tx.ts` already types `DrizzleTx.withTransaction` as `TransactionManager<TClient>['withTransaction']` (guarded by `create-drizzle-tx.test-d.ts`).

**Depends on:** Plan A + Plan B (both landed). Current state verified: `result.ts` has no brand and still exports `assertNever`; `transaction-manager.ts` has the 4 plain overloads; `TransactionWork` (in `propagation-plan.ts`) is `() => Promise<Result<T,E>>`; `index.ts` still `export *`s from `errors`/`logger`/`options`/`propagation`/`result`/`adapters/port`; `packages/nestjs/src/index.ts` re-exports `assertNever`; `packages/nestjs/src/transaction-host.ts` re-declares all 4 overloads + an `as (...args: unknown[])` cast.

**Assumptions:**
- **`errors.ts` now has SEVEN factories** (Plan A added `serializationFailure`/`deadlockDetected`/`connectionLost`). E5's "export the `DrizzleTxError` constructors as adapter-author API" therefore covers all seven — a superset of the #32 spec's original four.
- **The phantom symbol is shared, not re-declared.** `IND` lives in `result.ts`; `propagation-plan.ts` references the SAME symbol via an exported poison type (`NonIndependent`). Re-declaring `unique symbol` elsewhere would mint a *different* symbol and break the brand match.
- **nestjs field-initialiser order:** the bound `withTransaction` must be assigned in the **constructor body** (after `this.#manager = manager`), NOT as a field initialiser — a `readonly withTransaction = this.#manager…` initialiser runs before the constructor assigns `#manager` (undefined → crash).
- **Overload/impl compatibility:** the impl signature keeps returning `Promise<Result<T, E | DrizzleTxError>>`. If `tsc` reports the branded overload is "not compatible with its implementation signature", cast the impl's return `as Promise<Independent<T, E | DrizzleTxError>>` (sound — the runtime value is a plain `Result`; `Independent` is `Result` + a never-set phantom). The #31 spike compiled cleanly without the cast; treat it as a known fallback.
- **`assertNever`-withheld is compile-enforced:** after it's dropped from `core/index.ts`, the nestjs barrel's `import { assertNever } from '@drizzle-tx/core'` fails `pnpm typecheck` until removed — so nestjs is updated in the same task and typecheck is the guard (no fragile self-package-import test-d needed).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/result.ts` | `Independent`, `settle`, `NonIndependent`, `IND` | **Modify** — add the brand; keep `assertNever` (module-internal) |
| `packages/core/src/propagation-plan.ts` | `TransactionWork` poison | **Modify** — return type → `Promise<NonIndependent<T,E>>` |
| `packages/core/src/transaction-manager.ts` | Branded overloads + REQUIRES_NEW JSDoc | **Modify** — split overloads (6); no runtime change |
| `packages/core/src/index.ts` | Deliberate two-tier export surface | **Modify** — `export *` → explicit named; add `WithTransaction`/`Independent`/`settle`; drop `assertNever` |
| `packages/nestjs/src/transaction-host.ts` | E4 acceptance witness | **Modify** — 4 overloads + cast → one bound field |
| `packages/nestjs/src/index.ts` | Barrel | **Modify** — drop `assertNever`; add `Independent`/`settle` |
| `packages/core/test/types/independent-brand.test-d.ts` | Brand guardrails | **Create** |
| `packages/core/test/types/create-drizzle-tx.test-d.ts` | Strengthen REQUIRES_NEW assertion | **Modify** |
| `packages/core/README.md` (or propagation guide) | Diagnostic-locality callout | **Modify** — small docs note |

*(No runtime/integration test file changes: the brand rejects only a bare `return <REQUIRES_NEW result>`, and the suite has none — see Task 2.)*

---

### Task 1: The `Independent` brand + poisoned `TransactionWork` (type-level core)

**Files:**
- Modify: `packages/core/src/result.ts`, `packages/core/src/propagation-plan.ts`
- Test: `packages/core/test/types/independent-brand.test-d.ts`

**Depends on:** Plan A/B only. **Riskiest-first:** the whole feature rests on the phantom-poison mechanism compiling exactly as the #31 spike proved. Prove it before touching the overloads. **No runtime change** — this is a `.test-d.ts` (typecheck) task, not a `vitest run` task.

- [ ] **Step 1: Write the failing brand guardrail test**

Create `packages/core/test/types/independent-brand.test-d.ts` (mirrors the #31 spike's six cases):

```ts
import type { Independent, Result } from '../../src/result.js';
import { err, ok, settle } from '../../src/result.js';
import type { TransactionWork } from '../../src/propagation-plan.js';

declare const indep: Independent<number, { kind: 'X' }>;

// (1) inspection is UNTAXED — .ok/.value/.error read directly through the brand:
const _isOk: boolean = indep.ok;
if (indep.ok) { const _v: number = indep.value; void _v; } else { const _e: { kind: 'X' } = indep.error; void _e; }
void _isOk;

// (2) an Independent IS assignable to a plain Result (superset), so inspection/adaptation works:
const _asResult: Result<number, { kind: 'X' }> = indep;
void _asResult;

// (3) settle() unwraps to a plain Result (the conscious escape):
const _settled: Result<number, { kind: 'X' }> = settle(indep);
void _settled;

// (4) THE GUARDRAIL: an Independent cannot be RETURNED as transactional work output.
//     TransactionWork's return is poisoned; a branded value violates { [IND]?: never }.
const _blockedWork: TransactionWork<number, { kind: 'X' }> =
  // @ts-expect-error — returning an Independent as work output is the footgun the brand blocks
  async () => indep;
void _blockedWork;

// (5) a plain Result work is UNAFFECTED (assignable to the poisoned return):
const _plainWork: TransactionWork<number, { kind: 'X' }> = async () => (Math.random() > 1 ? ok(1) : err({ kind: 'X' as const }));
void _plainWork;

// (6) settle(inner) IS a valid work return (conscious propagation):
const _settleWork: TransactionWork<number, { kind: 'X' }> = async () => settle(indep);
void _settleWork;
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `pnpm --filter @drizzle-tx/core exec tsc -p tsconfig.test-d.json --noEmit`
Expected: FAIL — `Independent`/`settle` are not exported from `result.js`; and the `@ts-expect-error` on case (4) is *unused* (nothing to error against yet) which is itself a compile error.

- [ ] **Step 3: Implement the brand**

In `packages/core/src/result.ts`, add (keep `assertNever` exactly as-is — it stays module-internal):

```ts
declare const IND: unique symbol;

/** A REQUIRES_NEW outcome that already settled on its OWN connection. Inspect it directly
 *  (`.ok`/`.value`/`.error`); it CANNOT be `return`ed as an outer Result by accident —
 *  `settle()` it consciously to propagate its outcome to the outer transaction. Zero runtime cost. */
export type Independent<T, E> = Result<T, E> & { readonly [IND]: true };

/** The transactional-work return poison: a Result that must NOT be a branded `Independent`
 *  (`true ⊄ never`). A plain Result satisfies it (the optional phantom is absent); an
 *  `Independent` does not — so `return inner` for a REQUIRES_NEW outcome fails to compile. */
export type NonIndependent<T, E> = Result<T, E> & { readonly [IND]?: never };

/** Unwrap an `Independent` to a plain `Result` (runtime: identity, ZERO cost). Returning this at
 *  the outer boundary is the conscious opt-in that "inner err → outer rollback". */
export const settle = <T, E>(i: Independent<T, E>): Result<T, E> => i as Result<T, E>;
```

In `packages/core/src/propagation-plan.ts`, change the `TransactionWork` return to the poison (import the type):

```ts
// was: import { assertNever, type Result } from './result.js';
// now (drop the now-unused `type Result`; TransactionWork uses NonIndependent):
import { assertNever, type NonIndependent } from './result.js';
// ...
/** A unit of transactional work … (return poisoned so a branded REQUIRES_NEW `Independent`
 *  can't be returned as work output — see result.ts `NonIndependent`). */
export type TransactionWork<T, E> = () => Promise<NonIndependent<T, E>>;
```

(Confirm `planTransaction` still uses `assertNever` — the import stays. `type Result` was only referenced by the old `TransactionWork` definition, so it's now dead — remove it to keep the file clean.)

- [ ] **Step 4: Run typecheck to verify it passes**

Run: `pnpm --filter @drizzle-tx/core exec tsc -p tsconfig.test-d.json --noEmit`
Expected: PASS — cases (1)–(3),(5),(6) compile; case (4)'s `@ts-expect-error` is consumed (returning `indep` violates the poisoned return). Then run the fast core typecheck to confirm the `TransactionWork` change didn't break existing callers (plain Result work is still assignable):
Run: `pnpm --filter @drizzle-tx/core exec tsc --noEmit`
Expected: PASS — `transaction-scope.ts`/`transaction-manager.ts` internals unaffected (a plain `Result` satisfies `NonIndependent`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/result.ts packages/core/src/propagation-plan.ts packages/core/test/types/independent-brand.test-d.ts
git commit -m "feat(core): Independent<T,E> brand + settle() + poisoned TransactionWork return (#31)"
```

---

### Task 2: Brand the `withTransaction` overloads (REQUIRES_NEW → Independent)

**Files:**
- Modify: `packages/core/src/transaction-manager.ts`
- Modify: `packages/core/test/types/create-drizzle-tx.test-d.ts`

**Depends on Task 1.** Split the overloads so the `'REQUIRES_NEW'` literal returns `Independent`, and strengthen the type-test to assert the brand. **No runtime change, and no existing call site needs fixing** (see the note after Step 3).

- [ ] **Step 1: Strengthen the type-test to assert the brand**

In `packages/core/test/types/create-drizzle-tx.test-d.ts`, replace the existing REQUIRES_NEW assertion (`const _r2: Result<number, DrizzleTxError> = r2`) with a brand assertion, and add a footgun-blocked case. Add imports for `Independent`, `settle`:

```ts
import { err, ok, settle, type Independent, type Result } from '../../src/result.js';

// REQUIRES_NEW yields the BRAND, not a plain Result:
const r2 = await tx.withTransaction('REQUIRES_NEW', async () => ok(1));
const _branded: Independent<number, DrizzleTxError> = r2;       // must hold
const _stillResult: Result<number, DrizzleTxError> = r2;        // Independent ⊆ Result — also holds
void _branded; void _stillResult;

// a non-REQUIRES_NEW form yields a PLAIN Result (NOT Independent):
const r3 = await tx.withTransaction('REQUIRED', async () => ok(1));
// @ts-expect-error — REQUIRED does not brand; a plain Result is not assignable to Independent
const _notBranded: Independent<number, DrizzleTxError> = r3;
void _notBranded;

// the footgun is blocked at the work boundary, and settle() is the escape.
// ⚠️ DIAGNOSTIC LOCALITY (#31 "one real cost"): returning an inner Independent makes TS reject the
// whole OUTER `withTransaction('REQUIRES_NEW', …)` call (TS2769 "No overload matches"), NOT the
// `return inner` line — so the @ts-expect-error MUST sit on the outer call, or it's unused (TS2578)
// AND the real error goes unsuppressed. (Verified empirically by the plan reviewer.)
async function footgun() {
  // @ts-expect-error — returning an inner Independent as work output is blocked (error lands here)
  const outer = await tx.withTransaction('REQUIRES_NEW', async () => {
    const inner = await tx.withTransaction('REQUIRES_NEW', async () => err({ kind: 'Inner' } as const));
    return inner;
  });
  void outer;
  const outer2 = await tx.withTransaction('REQUIRES_NEW', async () => {
    const inner = await tx.withTransaction('REQUIRES_NEW', async () => err({ kind: 'Inner' } as const));
    return settle(inner);   // conscious propagation — compiles
  });
  void outer2;
}
void footgun;
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `pnpm --filter @drizzle-tx/core exec tsc -p tsconfig.test-d.json --noEmit`
Expected: FAIL — `_branded` assignment fails (REQUIRES_NEW still returns plain `Result`), and the two `@ts-expect-error` directives are unused.

- [ ] **Step 3: Split the overloads in the manager**

In `packages/core/src/transaction-manager.ts`, import `Independent` from `result.js`, and replace the four overload declarations (the impl signature + body stay unchanged) with six — REQUIRES_NEW literals **first** so a literal argument resolves to the branded overload before the general `Propagation` one:

```ts
// REQUIRES_NEW literal → Independent (an inner that settled on its own connection):
withTransaction<T, E>(
  propagation: 'REQUIRES_NEW',
  work: TransactionWork<T, E>,
): Promise<Independent<T, E | DrizzleTxError>>;
withTransaction<T, E>(
  propagation: 'REQUIRES_NEW',
  options: TxOptions,
  work: TransactionWork<T, E>,
): Promise<Independent<T, E | DrizzleTxError>>;
// every other form → plain Result:
withTransaction<T, E>(work: TransactionWork<T, E>): Promise<Result<T, E | DrizzleTxError>>;
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
// impl signature + body unchanged (returns Promise<Result<T, E | DrizzleTxError>>).
```

If `tsc` reports overload/impl incompatibility, apply the Assumptions cast to the impl return.

> **No existing-suite call site needs fixing.** The brand only rejects a *bare* `return <REQUIRES_NEW result>` from a work callback. The reviewer verified every REQUIRES_NEW site in the suite already uses `return ok(inner)` (surfaces the inner as a value — compiles unchanged), and the "propagate inner err" integration test's `inner` comes from `Propagation.Required` (a **plain** Result, never branded — so `return inner` there stays valid and `settle(inner)` would be a *type error*). Task 1's poison is therefore safe against the whole existing suite; only the new type-test assertions above are added.

- [ ] **Step 4: Run typecheck to verify pass**

Run: `pnpm --filter @drizzle-tx/core exec tsc -p tsconfig.test-d.json --noEmit`
Expected: PASS — `_branded` holds; all three `@ts-expect-error` directives (the REQUIRED-isn't-branded one and the two footgun ones) are consumed.
Run: `pnpm build && pnpm typecheck`
Expected: PASS — core builds; the root `tsc -b` typecheck (incl. the integration-test glob) stays green (no integration-test edit was needed).
Run: `pnpm test:int` (Docker)
Expected: PASS — runtime unchanged (the brand is type-only; no behavior change).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transaction-manager.ts packages/core/test/types/create-drizzle-tx.test-d.ts
git commit -m "feat(core): brand the REQUIRES_NEW withTransaction overloads as Independent (#31)"
```

---

### Task 3: E4 — export `WithTransaction<TClient>` + refactor nestjs `TransactionHost`

**Files:**
- Modify: `packages/core/src/index.ts` (add the alias only — full tiering is Task 4)
- Modify: `packages/nestjs/src/transaction-host.ts`

**Depends on Task 2.** The E4 acceptance witness: nestjs collapses from 4 re-declared overloads + cast to one bound field.

- [ ] **Step 1: Export `WithTransaction` from core**

Add to `packages/core/src/index.ts` (a standalone export near the manager export; Task 4 relocates it into the adapter-author tier):

```ts
import type { TransactionManager } from './transaction-manager.js';
/** @remarks Adapter-author API. The `withTransaction` overload contract (incl. the REQUIRES_NEW
 *  `Independent` brand) — reference this instead of re-declaring the overloads when wrapping the manager. */
export type WithTransaction<TClient> = TransactionManager<TClient>['withTransaction'];
```

(`TransactionManager` is already imported/exported by index.ts; reuse the existing import if present.)

- [ ] **Step 2: Refactor the nestjs host to a bound field**

In `packages/nestjs/src/transaction-host.ts`: delete the four re-declared overloads AND the variadic impl-with-cast, and replace with a bound field assigned **in the constructor body** (see Assumptions — not a field initialiser). Update imports: add `WithTransaction`; remove now-unused `Propagation`, `TransactionWork` (keep `TxOptions`, `Result`, `DrizzleTxError`, `TransactionScope` — still used by `begin`).

```ts
import type { DrizzleTxError, Result, TransactionManager, TransactionScope, TxOptions, WithTransaction } from '@drizzle-tx/core';
// ...
@Injectable()
export class TransactionHost {
  readonly #manager: TransactionManager<unknown>;
  /** Forwards to the manager, preserving all six overloads (incl. the REQUIRES_NEW brand). */
  readonly withTransaction: WithTransaction<unknown>;

  constructor(@Inject(DRIZZLE_TX_MANAGER) manager: TransactionManager<unknown>) {
    this.#manager = manager;
    this.withTransaction = manager.withTransaction.bind(manager);
    registry.set(DEFAULT_KEY, this);
  }
  // ... get/tx/isTransactionActive/begin unchanged ...
}
```

- [ ] **Step 3: Typecheck to verify the witness holds**

Run: `pnpm build` (core first — nestjs typechecks against core's built `dist`)
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS — nestjs `TransactionHost.withTransaction` type-checks with **no** re-declared overloads and **no** cast; the `WithTransaction<unknown>` bound field carries the full overload set. Run the nestjs tests to confirm runtime DI still wires:
Run: `pnpm test:nestjs` (Docker)
Expected: PASS — the host still forwards to the manager; `@Transactional` + injected-client tests green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts packages/nestjs/src/transaction-host.ts
git commit -m "feat(core): export WithTransaction<TClient>; nestjs TransactionHost uses the bound field (E4, #32)"
```

---

### Task 4: E5 — deliberate two-tier export surface + drop `assertNever`

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/nestjs/src/index.ts`

**Depends on Task 3.** Convert every `export *` to explicit named exports, grouped into an app-dev tier and an adapter-author tier; add `Independent`/`settle`; drop `assertNever` from both public surfaces.

- [ ] **Step 1: Rewrite `core/index.ts` as the explicit tiered surface**

Replace the whole file with the enumerated surface (folds in Task 3's `WithTransaction`):

```ts
// ─── Tier A: app-developer API ────────────────────────────────────────────────
export { createDrizzleTx, type CreateDrizzleTxOptions, type DrizzleTx } from './create-drizzle-tx.js';
export {
  type Result, type Ok, type Err, ok, err, isOk, isErr,
  map, mapErr, andThen, unwrapOr, match,
  type Independent, settle,
} from './result.js';
export {
  type DrizzleTxError, type DrizzleTxErrorKind, type DrizzleTxErrorHandlers, matchError,
} from './errors.js';
export { Propagation } from './propagation.js';
// (TxFailureFields is exported in Tier B — it's the factories' parameter type.)
export { type TxOptions, type IsolationLevel, type AccessMode } from './options.js';
export { type TxLogger, noopLogger, consoleLogger } from './logger.js';
export type { TransactionScope } from './transaction-scope.js';
export type { TransactionWork } from './transaction-manager.js';
export { UnsupportedDriverError } from './driver-capability.js';
export { type DrizzleAdapterConfig, type DrizzleTxCapable } from './adapters/drizzle.js';

// ─── Tier B: adapter-author API ───────────────────────────────────────────────
import type { TransactionManager as _TM } from './transaction-manager.js';
/** @remarks Adapter-author API. The withTransaction overload contract (incl. REQUIRES_NEW brand). */
export type WithTransaction<TClient> = _TM<TClient>['withTransaction'];
export { TransactionManager, type TransactionManagerOptions } from './transaction-manager.js';
export type { TransactionAdapter } from './adapters/port.js';
export { DrizzleAdapter } from './adapters/drizzle.js';
export { createTransactionalClient } from './transactional-client.js';
export {
  type TxFailureFields,
  poolConnectionTimeout, transactionAborted, hostNotInitialized, notPoolBacked,
  serializationFailure, deadlockDetected, connectionLost,
} from './errors.js';

// NOT exported (internal): assertNever (result.ts) — use matchError for DrizzleTxError exhaustiveness.
// NOT exported (internal): NonIndependent (result.ts) — a work-return implementation detail, referenced
//   structurally by TransactionWork; not something consumers name.
```

Note: **all seven** error factories plus their parameter type `TxFailureFields` are exported (Plan A added `serializationFailure`/`deadlockDetected`/`connectionLost` + `TxFailureFields`; a superset of the #32 spec's four). `assertNever` is the **only** *previously-public* symbol now withheld (`NonIndependent` is newly introduced by this plan and deliberately never public).

- [ ] **Step 2: Update the nestjs barrel**

In `packages/nestjs/src/index.ts`: remove `assertNever` from the re-export list; add `type Independent` and `settle` (nestjs re-exports the Result surface for one-import ergonomics):

```ts
export type { DrizzleTxError, DrizzleTxErrorKind, Independent, Result, TransactionScope, TransactionWork, TxOptions } from '@drizzle-tx/core';
export {
  andThen, err, isErr, isOk, map, mapErr, match, matchError, ok, Propagation, settle, unwrapOr,
} from '@drizzle-tx/core';
// (assertNever removed)
// ... module/decorator/token exports unchanged ...
```

- [ ] **Step 3: Typecheck — the compile-enforced `assertNever` guard**

Run: `pnpm build`
Expected: PASS.
Run: `pnpm typecheck`
Expected: PASS. Crucially, if `assertNever` were still imported anywhere from `@drizzle-tx/core` (e.g. a missed nestjs barrel line), this FAILS with "no exported member 'assertNever'" — so a green typecheck *is* the proof the public leak is closed. (Intra-package `import { assertNever } from '../../src/result.js'` in core's own `*.test-d.ts` is unaffected — it imports from the module, not the package.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts packages/nestjs/src/index.ts
git commit -m "feat(core): deliberate two-tier export surface; drop assertNever from public API (E5, #32)"
```

---

### Task 5: Docs — REQUIRES_NEW diagnostic-locality callout

**Files:**
- Modify: `packages/core/src/transaction-manager.ts` (JSDoc on the REQUIRES_NEW overloads)
- Modify: `packages/core/README.md` (a short propagation note)

**Depends on Task 2.** The #31 "one real cost": the compile error for `return inner` lands at the `withTransaction(...)` **call site**, not the offending `return` line — so make the fix discoverable from the message.

- [ ] **Step 1: JSDoc the REQUIRES_NEW overloads**

Add above the two `'REQUIRES_NEW'` overloads in `transaction-manager.ts`:

```ts
/** REQUIRES_NEW runs on its OWN connection; its outcome is an `Independent<T,E>` — a value you
 *  inspect (`.ok`/`.value`/`.error`), NOT something to `return` directly from the outer work.
 *  `return inner` is a compile error (the error points at the outer `withTransaction(...)` call,
 *  not the return line). To propagate the inner outcome as the outer's, `return settle(inner)`
 *  consciously; to commit the outer regardless, `return ok(inner)`. */
```

- [ ] **Step 2: README propagation note**

In `packages/core/README.md`, add a short note under the propagation/REQUIRES_NEW section: an inner `REQUIRES_NEW` result is `Independent`; `return inner` won't compile (guardrail against accidentally rolling the outer back on the inner's error) — use `settle(inner)` to propagate or `ok(inner)` to surface it as a value. If the compile error appears at the outer call site rather than the `return`, this is why.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/transaction-manager.ts packages/core/README.md
git commit -m "docs(core): REQUIRES_NEW Independent brand — settle()/ok() escapes + diagnostic-locality note (#31)"
```

---

### Task 6: Final gate

**Files:** none (verification only).

- [ ] **Step 1: Full build + typecheck + test + publish check**

Run: `pnpm build`
Expected: PASS — core (tsdown dual ESM+CJS), nestjs (tsc CJS).
Run: `pnpm typecheck`
Expected: PASS — all `*.test-d.ts` incl. `independent-brand.test-d.ts` + the strengthened `create-drizzle-tx.test-d.ts`; nestjs host + barrel compile with `assertNever` gone and `WithTransaction` in use.
Run: `pnpm test` (unit + core-integration + nestjs; Docker)
Expected: PASS — runtime behavior unchanged (the brand is type-only; `settle` is identity).
Run: `pnpm -r run check:publish`
Expected: PASS — `attw` + `publint --strict` resolve the new `WithTransaction`/`Independent`/`settle` exports in both ESM and CJS; no `export *` remains in `core/index.ts`.

- [ ] **Step 2: Confirm the surface is deliberate**

Sanity greps (advisory — both should return nothing):
```bash
grep -n "export \*" packages/core/src/index.ts        # expect: no matches
grep -n "assertNever" packages/core/src/index.ts packages/nestjs/src/index.ts  # expect: no matches
```

- [ ] **Step 3: CONTEXT.md / spec status (do in this PR, not a separate commit)**

Note: update `CONTEXT.md` if it enumerates the public export surface or the `withTransaction` return type, and flip the #31 prototype / #32 spec status references to "implemented" when merging — in lockstep with this code, not before.

---

## Downstream (later plans — NOT in this plan)

- **Plan D** (ADR-0014 scope robustness: `disposeTimeoutMs`) and **Plan E** (T1 concurrency, T3 deep-nesting, cheap fixes R4/E7/T5/Q1/Q3) are independent of this plan.
- The exported `WithTransaction<TClient>` is the contract the **flagship Next.js/tRPC adapters** (#12–#14) build on — this plan is the last core-surface prerequisite before that effort.
- `@drizzle-tx/nestjs/testing` and any adapter-author guide referencing the new Tier-B surface are follow-ups, not part of this plan.
