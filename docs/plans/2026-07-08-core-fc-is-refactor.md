# `@drizzle-tx/core` Functional-Core / Imperative-Shell Refactor — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use the repo's available execution skill when one exists (for example, `subagent-driven-development` or `executing-plans`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the tangled 290-line `transaction-manager.ts` into a pure functional core (propagation planning, throw↔`Result` translation) plus thin effect modules (ALS context, scope bridge), removing the in-place ALS mutation — with zero change to observable behavior.

**Architecture:** Extract pure decision logic into `propagation-plan.ts` and `rollback-boundary.ts`; encapsulate `AsyncLocalStorage` in a deep `transaction-context.ts` that hides an *immutable* store; extract the `begin()` gate machinery into `transaction-scope.ts`. The `TransactionManager` becomes a thin coordinator that snapshots ALS into a value, asks the pure core what to do, and interprets the resulting `TxPlan`. The adapter port drops its `setClient` mutation callback and instead hands the tx client to a callback.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly`, `ESNext.Disposable`), Vitest 4 (projects: `core-unit` no-DB, `core-integration` Testcontainers/Postgres), tsdown dual build. Spec: [`docs/prds/core-architecture-refactor-v2.0-prd.md`](../prds/core-architecture-refactor-v2.0-prd.md).

**Assumptions:**
- Per-task commits use Conventional Commits (matches repo history); adjust if you don't want per-task commits.
- Single core-unit test file runs via `pnpm exec vitest run --project core-unit <path-from-repo-root>` (verified). Full no-DB suite: `pnpm test:unit`. Real-Postgres regression: `pnpm test:int` (requires a running Docker daemon).
- `TxPlan`, `planTransaction`, `transaction-context`, `rollback-boundary`, and `openScope` stay **internal** (not re-exported from `index.ts`) to keep the public surface minimal; only existing public exports remain public.
- `assertNever` is imported from `./result.js` (existing). New `*.test-d.ts` files are auto-checked by `tsconfig.test-d.json` and excluded from the build (verified).
- `planTransaction`'s unreachable `default` uses `assertNever` (fail-fast on an impossible propagation value) instead of the current defensive "start a new transaction" fallback. This is an intentional, type-guaranteed-unreachable improvement; noted here so it isn't mistaken for a behavior regression.

**Riskiest work / sequencing note:** The genuinely risky change is Task 5 (inverting *where* `als.run()` is entered + the port change). The plan front-loads the cheap pure extractions (Tasks 1–3) because the shell must interpret a `TxPlan` and use `classifyRollback` *before* the context can be cleanly swapped — otherwise the coordinator gets rewritten twice. Risk still surfaces on ~day 2 of a ~4.5-day plan, and the untouched `core-integration` suite is the behavioral oracle gating Tasks 5 and 6. If Task 5's integration run shows any `getTransactionClient()` identity divergence, **stop** — the inversion assumption is wrong.

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `packages/core/src/propagation-plan.ts` | Create | Pure `TxPlan` union, `planTransaction`, `normalizeArgs` |
| `packages/core/src/propagation-plan.test.ts` | Create | Pure unit tests for the planner + arg normalizer |
| `packages/core/src/propagation-plan.test-d.ts` | Create | Type-level `TxPlan` exhaustiveness lock |
| `packages/core/src/rollback-boundary.ts` | Create | Pure `RollbackSignal`, `toThrowable`, `classifyRollback`, `isPoolTimeoutError` |
| `packages/core/src/rollback-boundary.test.ts` | Create | Pure unit tests for throw↔`Result` translation |
| `packages/core/src/transaction-context.ts` | Create | Deep ALS wrapper; immutable store; `run()`-only |
| `packages/core/src/transaction-context.test.ts` | Create | Boundary tests for context lifecycle |
| `packages/core/src/transaction-scope.ts` | Create | `TransactionScope`, `openScope` gate bridge |
| `packages/core/src/adapter.ts` | Modify | Drop `setClient`; `work` receives the tx client |
| `packages/core/src/drizzle-adapter.ts` | Modify | Implement the 2-arg port methods |
| `packages/core/src/transaction-manager.ts` | Modify | Slim coordinator: snapshot → plan → interpret; delegate scope |
| `packages/core/src/transaction-manager.test.ts` | Modify | Rewrite fake adapters to the new port |
| `docs/adr/0006-functional-core-imperative-shell.md` | Create | Record the FC/IS decision + port change |
| `CLAUDE.md`, `CONTEXT.md` | Modify | Update gotchas / module map |

---

## Task 1: Propagation Planner (pure decision + wire the shell)

**Files:**
- Create: `packages/core/src/propagation-plan.ts`
- Create: `packages/core/src/propagation-plan.test.ts`
- Create: `packages/core/src/propagation-plan.test-d.ts`
- Modify: `packages/core/src/transaction-manager.ts` (`#run`, `#join`, `#nested` dispatch, `#warnIfOptions`)
- Test: `packages/core/src/propagation-plan.test.ts`, existing `packages/core/src/transaction-manager.test.ts` (regression)

- [ ] **Step 1: Write the failing planner test**

```ts
// packages/core/src/propagation-plan.test.ts
import { describe, expect, it } from 'vitest';
import { Propagation } from './propagation.js';
import { planTransaction } from './propagation-plan.js';

describe('planTransaction', () => {
  it('REQUIRED + inactive → new-root carrying options', () => {
    expect(
      planTransaction({ propagation: Propagation.Required, active: false, supportsIndependentTransactions: true, options: { isolationLevel: 'serializable' } }),
    ).toEqual({ kind: 'new-root', options: { isolationLevel: 'serializable' } });
  });

  it('REQUIRED + active → join carrying ignoredOptions', () => {
    expect(
      planTransaction({ propagation: Propagation.Required, active: true, supportsIndependentTransactions: true, options: { isolationLevel: 'serializable' } }),
    ).toEqual({ kind: 'join', ignoredOptions: { isolationLevel: 'serializable' } });
  });

  it('REQUIRED + active + empty options → join WITHOUT ignoredOptions (no warn)', () => {
    // Preserves the original `#warnIfOptions` predicate: empty {} must NOT warn.
    expect(
      planTransaction({ propagation: Propagation.Required, active: true, supportsIndependentTransactions: true, options: {} }),
    ).toEqual({ kind: 'join', ignoredOptions: undefined });
  });

  it('REQUIRES_NEW + inactive → new-root', () => {
    expect(
      planTransaction({ propagation: Propagation.RequiresNew, active: false, supportsIndependentTransactions: false }),
    ).toEqual({ kind: 'new-root', options: undefined });
  });

  it('REQUIRES_NEW + active + not pool-backed → reject(NotPoolBacked)', () => {
    expect(
      planTransaction({ propagation: Propagation.RequiresNew, active: true, supportsIndependentTransactions: false }),
    ).toEqual({ kind: 'reject', error: { kind: 'NotPoolBacked' } });
  });

  it('REQUIRES_NEW + active + pool-backed → new-root', () => {
    expect(
      planTransaction({ propagation: Propagation.RequiresNew, active: true, supportsIndependentTransactions: true }),
    ).toEqual({ kind: 'new-root', options: undefined });
  });

  it('NESTED + active → nested carrying ignoredOptions', () => {
    expect(
      planTransaction({ propagation: Propagation.Nested, active: true, supportsIndependentTransactions: true, options: { accessMode: 'read only' } }),
    ).toEqual({ kind: 'nested', ignoredOptions: { accessMode: 'read only' } });
  });

  it('NESTED + inactive → new-root', () => {
    expect(
      planTransaction({ propagation: Propagation.Nested, active: false, supportsIndependentTransactions: true }),
    ).toEqual({ kind: 'new-root', options: undefined });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit packages/core/src/propagation-plan.test.ts`
Expected: FAIL — cannot resolve module `./propagation-plan.js` (file does not exist yet).

- [ ] **Step 3: Write the planner module**

```ts
// packages/core/src/propagation-plan.ts
import { type DrizzleTxError, notPoolBacked } from './errors.js';
import type { TxOptions } from './options.js';
import { Propagation } from './propagation.js';
import { assertNever } from './result.js';
import type { TransactionWork } from './transaction-manager.js';

/** A plain-data description of what a withTransaction call should do. The pure core
 *  produces this; the imperative shell interprets it. */
export type TxPlan =
  | { readonly kind: 'join'; readonly ignoredOptions?: TxOptions }
  | { readonly kind: 'new-root'; readonly options?: TxOptions }
  | { readonly kind: 'nested'; readonly ignoredOptions?: TxOptions }
  | { readonly kind: 'reject'; readonly error: DrizzleTxError };

export interface PropagationInputs {
  readonly propagation: Propagation;
  /** Snapshot of ALS state — NOT the live store. */
  readonly active: boolean;
  readonly supportsIndependentTransactions: boolean;
  readonly options?: TxOptions;
}

/** Options only "count" as ignored (and thus warn-worthy) when non-empty — this preserves
 *  the original `#warnIfOptions` predicate (`Object.keys(options).length > 0`) so an empty
 *  `{}` does not trigger a warning. */
const ignoredIfPresent = (options?: TxOptions): TxOptions | undefined =>
  options && Object.keys(options).length > 0 ? options : undefined;

/** Pure. The propagation truth-table. Exhaustive over Propagation. */
export function planTransaction(inputs: PropagationInputs): TxPlan {
  const { propagation, active, supportsIndependentTransactions, options } = inputs;
  switch (propagation) {
    case Propagation.Required:
      return active
        ? { kind: 'join', ignoredOptions: ignoredIfPresent(options) }
        : { kind: 'new-root', options };
    case Propagation.RequiresNew:
      if (active && !supportsIndependentTransactions) return { kind: 'reject', error: notPoolBacked() };
      return { kind: 'new-root', options };
    case Propagation.Nested:
      return active
        ? { kind: 'nested', ignoredOptions: ignoredIfPresent(options) }
        : { kind: 'new-root', options };
    default:
      return assertNever(propagation);
  }
}

/** Pure. Collapse the withTransaction overload shapes into a normalized triple. */
export function normalizeArgs<T, E>(
  a: Propagation | TxOptions | TransactionWork<T, E>,
  b?: TxOptions | TransactionWork<T, E>,
  c?: TransactionWork<T, E>,
): { readonly propagation: Propagation; readonly options?: TxOptions; readonly work: TransactionWork<T, E> } {
  if (typeof a === 'function') return { propagation: Propagation.Required, work: a };
  if (typeof a === 'string') {
    if (typeof b === 'function') return { propagation: a, work: b };
    return { propagation: a, options: b as TxOptions, work: c as TransactionWork<T, E> };
  }
  return { propagation: Propagation.Required, options: a, work: b as TransactionWork<T, E> };
}
```

- [ ] **Step 4: Run planner test to verify it passes**

Run: `pnpm exec vitest run --project core-unit packages/core/src/propagation-plan.test.ts`
Expected: PASS for all 7 `planTransaction` cases.

- [ ] **Step 5: Wire the shell to interpret the plan**

In `packages/core/src/transaction-manager.ts`:
- Add import: `import { planTransaction, type TxPlan } from './propagation-plan.js';`
- Replace the body of `#run` so it builds inputs, plans, and interprets:

```ts
#run<T, E>(
  propagation: Propagation,
  options: TxOptions | undefined,
  work: TransactionWork<T, E>,
): Promise<Result<T, E | DrizzleTxError>> {
  const plan = planTransaction({
    propagation,
    active: this.isTransactionActive(),
    supportsIndependentTransactions: this.#adapter.supportsIndependentTransactions,
    options,
  });
  switch (plan.kind) {
    case 'join':
      if (plan.ignoredOptions) this.#warnIgnoredOptions('joining an existing transaction');
      return work();
    case 'new-root':
      return this.#newTransaction(plan.options, work);
    case 'nested':
      if (plan.ignoredOptions) this.#warnIgnoredOptions('a NESTED (savepoint) transaction');
      // The 'nested' variant has no `options` field (savepoint isolation is fixed at the
      // outer tx). `#nested` ignores options anyway, so pass undefined.
      return this.#nested(undefined, work);
    case 'reject':
      return Promise.resolve(err(plan.error));
  }
}
```

- Delete `#join` (its body is now the `case 'join'` branch). Rename `#warnIfOptions` to `#warnIgnoredOptions(context: string)` taking only the context string (the "should I warn" decision now lives in the plan):

```ts
#warnIgnoredOptions(context: string): void {
  this.#logger.warn(
    `Transaction options are ignored for ${context}; isolation/access-mode apply only to a new top-level transaction.`,
  );
}
```

- In `#nested`, remove its internal `this.#warnIfOptions(...)` call (the shell warns before dispatching now).

- [ ] **Step 6: Run the regression + planner suites**

Run: `pnpm test:unit`
Expected: PASS — all existing `transaction-manager.test.ts` cases (including `warns and strips tx options when joining REQUIRED / NESTED`, `REQUIRES_NEW while active returns err(NotPoolBacked)`) plus the new `propagation-plan.test.ts`.

- [ ] **Step 7: Add the type-level exhaustiveness lock**

```ts
// packages/core/src/propagation-plan.test-d.ts
import { assertNever } from './result.js';
import type { TxPlan } from './propagation-plan.js';

// If a TxPlan variant is added without a case here, this fails to compile.
export function describePlan(plan: TxPlan): string {
  switch (plan.kind) {
    case 'join':
      return 'join';
    case 'new-root':
      return 'new-root';
    case 'nested':
      return 'nested';
    case 'reject':
      return `reject:${plan.error.kind}`;
    default:
      return assertNever(plan);
  }
}
```

Run: `pnpm -C packages/core run typecheck`
Expected: PASS (no TS errors; the `tsconfig.test-d.json` check includes the new file).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/propagation-plan.ts packages/core/src/propagation-plan.test.ts packages/core/src/propagation-plan.test-d.ts packages/core/src/transaction-manager.ts
git commit -m "refactor(core): extract pure propagation planner (TxPlan) from the manager"
```

---

## Task 2: Argument normalization (pure) — wire the overload body

**Files:**
- Modify: `packages/core/src/transaction-manager.ts` (`withTransaction` implementation signature body)
- Modify: `packages/core/src/propagation-plan.test.ts` (add `normalizeArgs` cases)
- Test: `packages/core/src/propagation-plan.test.ts`, existing `transaction-manager.test.ts` (regression)

- [ ] **Step 1: Write the failing normalizeArgs test**

Append to `packages/core/src/propagation-plan.test.ts`:

```ts
import { normalizeArgs } from './propagation-plan.js';
import { ok } from './result.js';

describe('normalizeArgs', () => {
  const work = async () => ok(1);

  it('(work) → REQUIRED, no options', () => {
    expect(normalizeArgs(work)).toEqual({ propagation: 'REQUIRED', work });
  });
  it('(propagation, work)', () => {
    expect(normalizeArgs('NESTED', work)).toEqual({ propagation: 'NESTED', work });
  });
  it('(propagation, options, work)', () => {
    const options = { isolationLevel: 'serializable' } as const;
    expect(normalizeArgs('REQUIRES_NEW', options, work)).toEqual({ propagation: 'REQUIRES_NEW', options, work });
  });
  it('(options, work) → REQUIRED with options', () => {
    const options = { accessMode: 'read only' } as const;
    expect(normalizeArgs(options, work)).toEqual({ propagation: 'REQUIRED', options, work });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project core-unit packages/core/src/propagation-plan.test.ts`
Expected: FAIL — `normalizeArgs` returns `undefined`/wrong shape (only if it isn't wired) OR passes if Task 1's module already exports it. If it already passes, that's fine — this task's value is Step 3 (wiring the shell) with the test as the guard; proceed.

- [ ] **Step 3: Use normalizeArgs in the shell**

Replace the `withTransaction` *implementation* body (the overload signatures above it stay unchanged) in `packages/core/src/transaction-manager.ts`:

```ts
withTransaction<T, E>(
  a: Propagation | TxOptions | TransactionWork<T, E>,
  b?: TxOptions | TransactionWork<T, E>,
  c?: TransactionWork<T, E>,
): Promise<Result<T, E | DrizzleTxError>> {
  const { propagation, options, work } = normalizeArgs(a, b, c);
  return this.#run(propagation, options, work);
}
```

Add `normalizeArgs` to the existing `./propagation-plan.js` import.

- [ ] **Step 4: Run the regression suite**

Run: `pnpm test:unit`
Expected: PASS — all `transaction-manager.test.ts` overload-dependent cases (`REQUIRED joins`, `REQUIRES_NEW`, `NESTED`, options-warning) still green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/propagation-plan.test.ts packages/core/src/transaction-manager.ts
git commit -m "refactor(core): route withTransaction overloads through pure normalizeArgs"
```

---

## Task 3: Rollback / error boundary (pure) — wire the shell

**Files:**
- Create: `packages/core/src/rollback-boundary.ts`
- Create: `packages/core/src/rollback-boundary.test.ts`
- Modify: `packages/core/src/transaction-manager.ts` (remove `RollbackSignal`, `isPoolTimeoutError`, `PoolTimeoutLike`, `#execute`, `#fromThrow`; use the new module)
- Test: `packages/core/src/rollback-boundary.test.ts`, existing `transaction-manager.test.ts` (regression)

- [ ] **Step 1: Write the failing boundary test**

```ts
// packages/core/src/rollback-boundary.test.ts
import { describe, expect, it } from 'vitest';
import { classifyRollback, RollbackSignal, toThrowable } from './rollback-boundary.js';
import { err, ok } from './result.js';

describe('toThrowable', () => {
  it('returns the value for ok', () => {
    expect(toThrowable(ok(42))).toBe(42);
  });
  it('throws a RollbackSignal carrying the error for err', () => {
    try {
      toThrowable(err('DOMAIN_FAIL' as const));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RollbackSignal);
      expect((e as RollbackSignal<string>).payload).toBe('DOMAIN_FAIL');
    }
  });
});

describe('classifyRollback', () => {
  it('unwraps a RollbackSignal back into err(payload)', () => {
    expect(classifyRollback(new RollbackSignal('DOMAIN_FAIL'))).toEqual({ ok: false, error: 'DOMAIN_FAIL' });
  });

  it('maps a PoolTimeoutError (by constructor name) to PoolConnectionTimeout', () => {
    class PoolTimeoutError {
      readonly timeoutMs = 250;
    }
    expect(classifyRollback(new PoolTimeoutError())).toEqual({
      ok: false,
      error: { kind: 'PoolConnectionTimeout', timeoutMs: 250 },
    });
  });

  it('maps an arbitrary throw to TransactionAborted preserving the cause', () => {
    const boom = new Error('kaboom');
    expect(classifyRollback(boom)).toEqual({ ok: false, error: { kind: 'TransactionAborted', cause: boom } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project core-unit packages/core/src/rollback-boundary.test.ts`
Expected: FAIL — cannot resolve `./rollback-boundary.js`.

- [ ] **Step 3: Write the boundary module**

```ts
// packages/core/src/rollback-boundary.ts
import { type DrizzleTxError, poolConnectionTimeout, transactionAborted } from './errors.js';
import { err, type Result } from './result.js';

/** Internal throw used ONLY to carry a consumer error E through Drizzle's throw-to-rollback
 *  path; caught and re-materialized as a Result at the same boundary. */
export class RollbackSignal<E> {
  // Explicit field (not a parameter property) to satisfy `erasableSyntaxOnly`.
  readonly payload: E;
  constructor(payload: E) {
    this.payload = payload;
  }
}

/** Structural shape of the adapter's PoolTimeoutError. Kept here (not imported from the
 *  pg-backed adapter) so core never pulls `pg` into its module graph. */
interface PoolTimeoutLike {
  readonly timeoutMs: number | undefined;
}

/** Recognise the adapter's PoolTimeoutError by constructor name rather than instanceof. */
export function isPoolTimeoutError(e: unknown): e is PoolTimeoutLike {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { constructor?: { name?: string } }).constructor?.name === 'PoolTimeoutError'
  );
}

/** ok → the value; err → throw the rollback signal (the one place no-throw is inverted). */
export function toThrowable<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new RollbackSignal(result.error);
  return result.value;
}

/** Pure. Classify a throw caught at the transaction boundary into a Result error. */
export function classifyRollback<E>(e: unknown): Result<never, E | DrizzleTxError> {
  if (e instanceof RollbackSignal) return err(e.payload as E);
  if (isPoolTimeoutError(e)) return err(poolConnectionTimeout(e.timeoutMs));
  return err(transactionAborted(e));
}
```

- [ ] **Step 4: Run boundary test to verify it passes**

Run: `pnpm exec vitest run --project core-unit packages/core/src/rollback-boundary.test.ts`
Expected: PASS for all `toThrowable` and `classifyRollback` cases.

- [ ] **Step 5: Wire the shell to the boundary module**

In `packages/core/src/transaction-manager.ts`:
- Delete the local `class RollbackSignal`, `interface PoolTimeoutLike`, `function isPoolTimeoutError`, the `#execute` method, and the `#fromThrow` method.
- Add: `import { classifyRollback, toThrowable } from './rollback-boundary.js';`
- Drop the now-unused `notPoolBacked`, `poolConnectionTimeout`, `transactionAborted` imports from `./errors.js` **only if** no longer referenced (keep `DrizzleTxError`; `transactionAborted` is still used by the scope path in `begin()` — verify before removing).
- In `#newTransaction`, replace `async () => this.#execute(work)` with `async () => toThrowable(await work())`, and replace the `catch (e) { return this.#fromThrow<T, E>(e); }` with `catch (e) { return classifyRollback<E>(e); }`.
- Do the same substitution in `#nested`.

- [ ] **Step 6: Run the regression suite**

Run: `pnpm test:unit`
Expected: PASS — `transaction-manager.test.ts` cases `REQUIRED returns err when work returns err`, `wraps an unexpected throw as TransactionAborted`, plus all others.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/rollback-boundary.ts packages/core/src/rollback-boundary.test.ts packages/core/src/transaction-manager.ts
git commit -m "refactor(core): consolidate throw<->Result translation into rollback-boundary"
```

---

## Task 4: TransactionContext module (build standalone)

**Files:**
- Create: `packages/core/src/transaction-context.ts`
- Create: `packages/core/src/transaction-context.test.ts`
- Test: `packages/core/src/transaction-context.test.ts`

> Not wired into the manager yet — that happens in Task 5 together with the port change (they are one atomic compile unit).

- [ ] **Step 1: Write the failing context test**

```ts
// packages/core/src/transaction-context.test.ts
import { describe, expect, it } from 'vitest';
import { TransactionContext } from './transaction-context.js';

describe('TransactionContext', () => {
  it('reports inactive with no current client outside run()', () => {
    const ctx = new TransactionContext<{ tag: string }>();
    expect(ctx.isActive()).toBe(false);
    expect(ctx.current()).toBeUndefined();
  });

  it('exposes the client and reports active inside run()', async () => {
    const ctx = new TransactionContext<{ tag: string }>();
    const client = { tag: 'tx1' };
    const seen = await ctx.run(client, async () => {
      expect(ctx.isActive()).toBe(true);
      return ctx.current();
    });
    expect(seen).toBe(client);
  });

  it('restores inactive after run() resolves', async () => {
    const ctx = new TransactionContext<{ tag: string }>();
    await ctx.run({ tag: 'tx1' }, async () => undefined);
    expect(ctx.isActive()).toBe(false);
    expect(ctx.current()).toBeUndefined();
  });

  it('nested run() shadows then restores the outer client', async () => {
    const ctx = new TransactionContext<{ tag: string }>();
    const outer = { tag: 'outer' };
    const inner = { tag: 'inner' };
    await ctx.run(outer, async () => {
      expect(ctx.current()).toBe(outer);
      await ctx.run(inner, async () => {
        expect(ctx.current()).toBe(inner);
      });
      expect(ctx.current()).toBe(outer);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project core-unit packages/core/src/transaction-context.test.ts`
Expected: FAIL — cannot resolve `./transaction-context.js`.

- [ ] **Step 3: Write the context module**

```ts
// packages/core/src/transaction-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

/** The immutable ALS payload. Presence of a store == a transaction is active. */
interface ActiveTx<TClient> {
  readonly client: TClient;
}

/** Deep module over AsyncLocalStorage: hides the store shape and the run()-only rule
 *  (enterWith is forbidden — ADR-0001). The store is constructed immutable; there is no
 *  setter for the client. */
export class TransactionContext<TClient> {
  readonly #als = new AsyncLocalStorage<ActiveTx<TClient>>();

  current(): TClient | undefined {
    return this.#als.getStore()?.client;
  }

  isActive(): boolean {
    return this.#als.getStore() !== undefined;
  }

  /** Establish an immutable transaction context for the async scope of `fn`. */
  run<T>(client: TClient, fn: () => Promise<T>): Promise<T> {
    return this.#als.run({ client }, fn);
  }
}
```

- [ ] **Step 4: Run context test to verify it passes**

Run: `pnpm exec vitest run --project core-unit packages/core/src/transaction-context.test.ts`
Expected: PASS for all four lifecycle cases.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transaction-context.ts packages/core/src/transaction-context.test.ts
git commit -m "feat(core): add TransactionContext deep module over AsyncLocalStorage"
```

---

## Task 5: Cornerstone — new adapter port + inverted ALS entry (removes the mutation)

**Files:**
- Modify: `packages/core/src/adapter.ts` (drop `setClient`)
- Modify: `packages/core/src/drizzle-adapter.ts` (implement 2-arg methods)
- Modify: `packages/core/src/transaction-manager.ts` (use `TransactionContext`; enter `run()` inside the adapter callback)
- Modify: `packages/core/src/transaction-manager.test.ts` (rewrite fake adapters to the new port)
- Test: `pnpm test:unit`, then `pnpm test:int` (Docker), then `pnpm build && pnpm typecheck`

> **Depends on Task 4.** This is one atomic change: the port signature and every implementer/consumer must change together to compile. Highest-risk task — the `core-integration` suite is the oracle.

- [ ] **Step 1: Change the port to hand the client to a callback**

Replace the two method signatures in `packages/core/src/adapter.ts`:

```ts
export interface TransactionAdapter<TClient> {
  getBaseClient(): TClient;
  readonly supportsIndependentTransactions: boolean;

  /** Start a new top-level transaction; the tx client is passed to `work`. */
  wrapWithTransaction<T>(options: TxOptions | undefined, work: (tx: TClient) => Promise<T>): Promise<T>;

  /** Start a savepoint from `parent`; the savepoint client is passed to `work`. */
  wrapWithNestedTransaction<T>(parent: TClient, work: (sp: TClient) => Promise<T>): Promise<T>;
}
```

- [ ] **Step 2: Update the Drizzle adapter implementation**

In `packages/core/src/drizzle-adapter.ts`, replace both methods (drop the `setClient` parameter; pass the drizzle tx/savepoint client straight to `work`):

```ts
wrapWithTransaction<T>(options: TxOptions | undefined, work: (tx: TClient) => Promise<T>): Promise<T> {
  return this.#db
    .transaction(async (tx) => work(tx), options)
    .catch((e: unknown) => {
      if (e instanceof Error && /timeout exceeded when trying to connect/i.test(e.message)) {
        throw new PoolTimeoutError(undefined);
      }
      throw e;
    });
}

wrapWithNestedTransaction<T>(parent: TClient, work: (sp: TClient) => Promise<T>): Promise<T> {
  return parent.transaction(async (sp) => work(sp));
}
```

- [ ] **Step 3: Rewrite the fake adapters in the manager test**

In `packages/core/src/transaction-manager.test.ts`, update `makeFakeAdapter` and the inline `failing` adapter to the 2-arg port. The tag-identity/commit/rollback tracking is preserved; only the signature and the `setClient(tx)` line change (the tx is now passed to `work`):

```ts
wrapWithTransaction: async (_options, work) => {
  const tx: FakeClient = { tag: `tx${++counter}` };
  begins.push(tx.tag);
  try {
    const result = await work(tx);
    commits.push(tx.tag);
    return result;
  } catch (e) {
    rollbacks.push(tx.tag);
    throw e;
  }
},
wrapWithNestedTransaction: async (_parent, work) => {
  const sp: FakeClient = { tag: `sp${++counter}` };
  savepoints.push(sp.tag);
  return work(sp);
},
```

And the `failing` adapter's nested method becomes `wrapWithNestedTransaction: (_p, work) => work({ tag: 'base' })`; its `wrapWithTransaction: () => Promise.reject(new Error('cannot start'))` is unchanged (it rejects before calling `work`).

> Note: the existing assertions that read `m.getTransactionClient().tag` inside `work` still hold — Step 4 makes `getTransactionClient()` resolve to the tx via `TransactionContext`.

- [ ] **Step 4: Swap the manager to TransactionContext with inverted run()**

In `packages/core/src/transaction-manager.ts`:
- Remove `import { AsyncLocalStorage } from 'node:async_hooks';` and the local `interface TxContext`.
- Add `import { TransactionContext } from './transaction-context.js';`
- Replace the field `readonly #als = new AsyncLocalStorage<TxContext<TClient>>();` with `readonly #ctx = new TransactionContext<TClient>();`
- Rewrite the getters:

```ts
getTransactionClient(): TClient {
  return this.#ctx.current() ?? this.#adapter.getBaseClient();
}
isTransactionActive(): boolean {
  return this.#ctx.isActive();
}
```

- Rewrite `#newTransaction` and `#nested` to enter `run()` **inside** the adapter callback (no pre-installed context, no mutation):

```ts
async #newTransaction<T, E>(
  options: TxOptions | undefined,
  work: TransactionWork<T, E>,
): Promise<Result<T, E | DrizzleTxError>> {
  try {
    const value = await this.#adapter.wrapWithTransaction(options, (tx) =>
      this.#ctx.run(tx, async () => toThrowable(await work())),
    );
    return ok(value);
  } catch (e) {
    return classifyRollback<E>(e);
  }
}

async #nested<T, E>(
  options: TxOptions | undefined,
  work: TransactionWork<T, E>,
): Promise<Result<T, E | DrizzleTxError>> {
  const parent = this.getTransactionClient();
  try {
    const value = await this.#adapter.wrapWithNestedTransaction(parent, (sp) =>
      this.#ctx.run(sp, async () => toThrowable(await work())),
    );
    return ok(value);
  } catch (e) {
    return classifyRollback<E>(e);
  }
}
```

> `begin()` is untouched here: its work callback still calls `this.getTransactionClient()`, which now returns the tx because `run(tx, …)` is active during the callback. Task 6 extracts it.

- [ ] **Step 5: Run the no-DB regression suite**

Run: `pnpm test:unit`
Expected: PASS — all `transaction-manager.test.ts` cases including `REQUIRED starts a transaction and exposes the tx client to work` (asserts `getTransactionClient().tag === 'tx1'`), `REQUIRED joins`, `NESTED uses a savepoint`, and all `begin()` scope cases.

- [ ] **Step 6: Run the real-Postgres oracle (Docker required)**

Run: `pnpm test:int`
Expected: PASS — `propagation.integration.test.ts`, `transaction-scope.integration.test.ts`, `drizzle-adapter.integration.test.ts` all green. **If any `getTransactionClient()` identity/propagation assertion fails, STOP** — the inversion assumption is invalid; revert Step 4 and re-evaluate before proceeding.

- [ ] **Step 7: Verify nestjs still builds and typechecks against the new port**

Run: `pnpm build && pnpm typecheck`
Expected: PASS — `@drizzle-tx/nestjs` compiles unchanged (it constructs `new DrizzleAdapter({ db })` and never implements the port).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/adapter.ts packages/core/src/drizzle-adapter.ts packages/core/src/transaction-manager.ts packages/core/src/transaction-manager.test.ts
git commit -m "refactor(core)!: adapter port hands tx client to callback; remove in-place ALS mutation"
```

---

## Task 6: Extract the scope bridge (`openScope`)

**Files:**
- Create: `packages/core/src/transaction-scope.ts`
- Modify: `packages/core/src/transaction-manager.ts` (move `TransactionScope`, `SCOPE_ROLLBACK`, and the `begin()` gate body out; delegate to `openScope`)
- Test: existing `transaction-manager.test.ts` begin() suite + `transaction-scope.integration.test.ts` (regression oracle)

> The existing `begin()` unit tests (`transaction-manager.test.ts` lines under `TransactionManager.begin (...)`) are the boundary tests for this module — they assert observable scope behavior through the public `begin()`, so they stay and must remain green (replace-don't-layer: no duplicate internal tests are added).

- [ ] **Step 1: Create the scope module (relocate the gate machinery verbatim)**

```ts
// packages/core/src/transaction-scope.ts
import { type DrizzleTxError, transactionAborted } from './errors.js';
import type { TxLogger } from './logger.js';
import { err, ok, type Result } from './result.js';

/** Internal sentinel: a scope disposed without commit() returns this err to roll back. */
const SCOPE_ROLLBACK: unique symbol = Symbol('drizzle-tx:scope-rollback');

/** A block-scoped transaction handle for the `await using` API. Rolls back on dispose
 *  UNLESS commit() is called (default-deny). Does NOT establish the ALS context. */
export interface TransactionScope<TClient> extends AsyncDisposable {
  readonly tx: TClient;
  commit(): void;
  rollback(): void;
}

/** Bridge a callback-scoped transaction runner to a block-scoped handle. `runNewTransaction`
 *  starts a new top-level transaction and runs the passed work inside it; `captureClient`
 *  returns the active tx client (called inside that work). */
export async function openScope<TClient>(
  // The error channel is `symbol | DrizzleTxError`: the work returns `err(SCOPE_ROLLBACK)`
  // (a symbol), and the runner may also fail to start the tx (DrizzleTxError). This exact
  // union is what makes the `result.error !== SCOPE_ROLLBACK` guard below type-check.
  runNewTransaction: (
    work: () => Promise<Result<void, symbol>>,
  ) => Promise<Result<void, symbol | DrizzleTxError>>,
  captureClient: () => TClient,
  logger: TxLogger,
): Promise<Result<TransactionScope<TClient>, DrizzleTxError>> {
  let outcome: 'commit' | 'rollback' = 'rollback'; // default-deny
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let capturedClient: TClient | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const settled = runNewTransaction(async () => {
    capturedClient = captureClient();
    markStarted();
    await gate;
    return outcome === 'commit' ? ok(undefined) : err(SCOPE_ROLLBACK);
  });

  await Promise.race([started, settled]);
  if (capturedClient === undefined) {
    const early = await settled;
    return early.ok
      ? err(transactionAborted(new Error('transaction closed before it started')))
      : err(early.error as DrizzleTxError);
  }

  const scope: TransactionScope<TClient> = {
    tx: capturedClient,
    commit: () => {
      outcome = 'commit';
    },
    rollback: () => {
      outcome = 'rollback';
    },
    [Symbol.asyncDispose]: async () => {
      releaseGate();
      const result = await settled;
      if (!result.ok && result.error !== SCOPE_ROLLBACK) {
        logger.warn(`transaction scope failed to settle: ${String(result.error)}`);
      }
    },
  };
  return ok(scope);
}
```

- [ ] **Step 2: Delegate `begin()` to `openScope`**

In `packages/core/src/transaction-manager.ts`:
- Delete the local `interface TransactionScope`, the `const SCOPE_ROLLBACK` symbol, and the entire gate body inside `begin()`.
- Add `import { openScope, type TransactionScope } from './transaction-scope.js';`
- Replace `begin()` with a thin delegation:

```ts
begin(options?: TxOptions): Promise<Result<TransactionScope<TClient>, DrizzleTxError>> {
  return openScope<TClient>(
    (work) => this.#newTransaction<void, symbol>(options, work),
    () => this.getTransactionClient(),
    this.#logger,
  );
}
```

- Keep re-exporting `TransactionScope` from `transaction-manager.ts` (re-export the imported type) so `index.ts`'s existing `export { …, type TransactionScope, … } from './transaction-manager.js'` stays valid — OR update `index.ts` to export it from `./transaction-scope.js`. Choose the `index.ts` update (cleaner):
  - In `transaction-manager.ts` remove `TransactionScope` from its own export list.
  - In `index.ts`, add `export { type TransactionScope } from './transaction-scope.js';` and drop `TransactionScope` from the `transaction-manager.js` export block.
- **Drop the now-dead `transactionAborted` import** from `transaction-manager.ts`. It was retained in Task 3 only for `begin()`'s early-failure path, which now lives in `openScope`. After this task the manager's only remaining `./errors.js` import is `type DrizzleTxError`. Confirm `ok` and `err` are both still used (`ok` in `#newTransaction`/`#nested`; `err` in `#run`'s `reject` case) and keep them. `noUnusedLocals` is not set, so `pnpm typecheck` won't flag the dead import — but Biome's `noUnusedImports` will under `pnpm lint`.

- [ ] **Step 3: Run the begin() regression + full no-DB suite**

Run: `pnpm test:unit`
Expected: PASS — every `TransactionManager.begin (...)` case (`opens a transaction and exposes the tx client`, `commit() then dispose COMMITS`, `dispose WITHOUT commit rolls back`, `explicit rollback() after commit() wins`, `returns err(NotPoolBacked)... when the transaction cannot start`).

- [ ] **Step 4: Run the scope integration oracle (Docker required)**

Run: `pnpm test:int`
Expected: PASS — `transaction-scope.integration.test.ts` (real `await using`, commit/rollback-on-dispose) green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transaction-scope.ts packages/core/src/transaction-manager.ts packages/core/src/index.ts
git commit -m "refactor(core): extract begin() scope bridge into transaction-scope module"
```

---

## Task 7: Docs, ADR, and full-suite gate

**Files:**
- Create: `docs/adr/0006-functional-core-imperative-shell.md`
- Modify: `CLAUDE.md` (gotchas: remove the `setClient`/in-place-mutation note; add the FC/IS module map)
- Modify: `CONTEXT.md` (only if terminology shifted — otherwise note "no change")
- Test: full `pnpm build && pnpm typecheck && pnpm test && pnpm -r run check:publish`

- [ ] **Step 1: Write ADR-0006**

Create `docs/adr/0006-functional-core-imperative-shell.md` mirroring the existing ADR format (title `# ...` on line 1; Context / Decision / Consequences sections). Record: the FC/IS split (`propagation-plan`, `rollback-boundary` pure; `transaction-context`, `transaction-scope` effect; manager = coordinator), and **Flagged Decisions A/B/C** from the PRD (adapter port drops `setClient`; ALS store is immutable / no `active` field; the "options ignored" decision is pure and the shell logs). Cross-reference ADR-0001 (run()-only) and the PRD.

- [ ] **Step 2: Update CLAUDE.md gotchas**

In `CLAUDE.md`, under "Non-obvious gotchas", remove any wording implying the ALS store's client is mutated in place via `setClient`, and add a short "Functional core / imperative shell" bullet describing the module map (pure vs effect vs shell) and that the adapter port hands the tx client to a callback. Keep all other gotchas intact.

- [ ] **Step 3: Full green gate**

Run: `pnpm build && pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS — dual build succeeds; `tsc -b` + per-package + `*.test-d.ts` typecheck clean; all Vitest projects (`core-unit`, `core-integration`, `nestjs`) green; Biome reports no findings (catches any dead imports left by the extractions, e.g. a stray `transactionAborted`).

- [ ] **Step 4: Publish-lint gate**

Run: `pnpm -r run check:publish`
Expected: PASS — `publint --strict` + `attw` clean for both packages (no export-map regressions from the `index.ts` change).

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0006-functional-core-imperative-shell.md CLAUDE.md CONTEXT.md
git commit -m "docs(core): record FC/IS refactor (ADR-0006) and update gotchas"
```

---

## Done Signal

- All seven tasks committed; working tree clean.
- New pure unit suites (`propagation-plan.test.ts`, `rollback-boundary.test.ts`) and the `transaction-context.test.ts` boundary suite pass with no DB.
- The **unchanged** `core-integration` suite (propagation, scope, drizzle-adapter) passes — proving behavior is preserved.
- `transaction-manager.ts` no longer contains the propagation switch, the throw↔`Result` translation, the `AsyncLocalStorage` field, the in-place `client` mutation, or the `begin()` gate machinery — it is a coordinator.
- `pnpm build && pnpm typecheck && pnpm test && pnpm -r run check:publish` all green; `@drizzle-tx/nestjs` unchanged.
```
