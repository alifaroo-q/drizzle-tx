# Scope Robustness — `disposeTimeoutMs` Leak Backstop (Plan D) — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use the repo's available execution skill when one exists (for example, `executing-plans` or `tdd`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the `begin()`/`await using` scope against a **forgotten dispose** (ADR-0014 **R5**): an opt-in, generous `disposeTimeoutMs` backstop — **default OFF** — that, on fire, forces a default-deny rollback, releases the pooled connection, and emits a loud warning; **never throws**. Plus the docs half of ADR-0014 (**E1** two-primitive split, **E6** commit-failure reactability).

**Architecture:** The scope already bridges the adapter's callback-scoped transaction to a block scope via a **gate** promise: the work callback captures the client, parks on `gate`, and dispose releases it with a commit/rollback decision (`transaction-scope.ts` `openScope`). The backstop is a timer armed when the scope is handed out; on fire it does exactly what a forgotten dispose would do minus the commit intent — `outcome = 'rollback'`, `releaseGate()`, warn. A normal dispose **clears** the timer; a late dispose after the timer fired is idempotent (the tx already settled). **Default OFF** means no timer is armed unless a finite `disposeTimeoutMs` is configured, so every existing caller is byte-for-byte unchanged.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly`), Vitest 4 (fake timers for the backstop unit tests; real Postgres via Testcontainers for the connection-reclaim proof), tsdown dual ESM+CJS.

**Source of truth:** [ADR-0014](../adr/0014-two-primitive-split-and-scope-robustness.md) — **R5** (§Decision R5: two layers, invariant + opt-in default-off timer, on-fire behavior, idempotency), **E1** (§Decision E1: ratify the split, no new primitive, docs), **E6** (§Decision E6: docs-only, defer `scope.outcome`).

**Depends on:** Plans A–C (landed). Verified current state: `openScope(runNewTransaction, captureClient, logger)` (3 args, no timer); `TransactionManagerOptions` has only `logger`; `begin(options?: TxOptions)` forwards to `openScope` with `this.#logger`; `create-drizzle-tx.ts` types `begin` as the indexed `TransactionManager<TClient>['begin']` (so a signature change auto-propagates through the factory); nestjs `TransactionHost.begin(options?: TxOptions)` forwards to `manager.begin`.

**Assumptions:**
- **`disposeTimeoutMs` rides in a new `BeginOptions` (extends `TxOptions`), NOT in `TxOptions`.** The timeout is a scope-lifecycle concern, not a SQL option — `TxOptions` is shared with `withTransaction` and must stay SQL-only. `BeginOptions extends TxOptions { readonly disposeTimeoutMs?: number }`; a plain `TxOptions` is assignable to it (the field is optional), so `begin(txOptions)` callers are unbroken.
- **Resolution order:** `begin({ disposeTimeoutMs })` (per-call) wins; else `new TransactionManager(adapter, { disposeTimeoutMs })` (manager default); else **unset → no timer**. `Infinity` / non-finite is treated as unset (no timer).
- **The timer is `unref`'d** (`timer.unref?.()`) so the backstop never keeps the event loop alive; the optional-chain tolerates fake-timer objects that lack `unref`.
- **On fire, force rollback even over a prior `commit()`** — a committed-but-never-disposed scope is still a leak; default-deny is the safe reclaim (ADR-0014: "force the gate to resolve with the default-deny `rollback` outcome").
- **`openScope` is internal** (not exported from `index.ts`; only the `TransactionScope` *type* is public), so adding a 4th optional parameter is a non-breaking internal change — its existing 3-arg unit-test call sites keep compiling.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/transaction-scope.ts` | `openScope` gate bridge | **Modify** — 4th param `disposeTimeoutMs?`; arm/clear the backstop timer |
| `packages/core/src/transaction-manager.ts` | `begin` + options | **Modify** — `TransactionManagerOptions.disposeTimeoutMs`; `#disposeTimeoutMs`; `begin(options?: BeginOptions)` resolves + forwards the timeout |
| `packages/core/src/options.ts` | `BeginOptions` type | **Modify** — add `BeginOptions extends TxOptions` |
| `packages/core/src/index.ts` | Public surface | **Modify** — export `BeginOptions` (Tier A, beside `TxOptions`) |
| `packages/nestjs/src/transaction-host.ts` | Parity | **Modify** — `begin(options?: BeginOptions)` signature (mechanical) |
| `packages/core/README.md` + `CONTEXT.md` | E1/E6 docs | **Modify** — two-primitive split + leak-backstop framing + commit-failure note |
| `packages/core/test/unit/transaction-scope.test.ts` | Backstop unit tests | **Modify** |
| `packages/core/test/unit/transaction-manager.test.ts` | Resolution unit test | **Modify** |
| `packages/core/test/integration/transaction-scope.integration.test.ts` | R5 connection-reclaim proof | **Modify** |

---

### Task 1: The `disposeTimeoutMs` backstop in `openScope`

**Files:**
- Modify: `packages/core/src/transaction-scope.ts`
- Test: `packages/core/test/unit/transaction-scope.test.ts`

**Depends on:** Plans A–C only. **Riskiest-first:** the timer lifecycle (arm → fire-forces-rollback → clear-on-dispose → idempotent-late-dispose → default-off) is the whole feature and the easy place to leak or double-fire.

- [ ] **Step 1: Write the failing backstop tests**

Add to `packages/core/test/unit/transaction-scope.test.ts` (the `Runner` type + `captureClient` already exist at the top of the file). Add `afterEach` timer cleanup:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
// ... existing imports ...

afterEach(() => { vi.useRealTimers(); });

describe('openScope — disposeTimeoutMs leak backstop', () => {
  it('OFF by default: no timer armed when disposeTimeoutMs is undefined', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }); // no 4th arg
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(warn).not.toHaveBeenCalled();          // zero behavior change
    await opened.value[Symbol.asyncDispose]();     // clean up the parked work
  });

  it('fires on elapse: forces rollback, releases the gate, warns loudly', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let settled: Result<void, symbol> | undefined;
    // NOTE: this fake Runner captures the work's return directly (not routed through the manager's
    // #runInBoundary), so `settled` is the raw rollback sentinel — assert only `.ok === false` here.
    const run: Runner = async (work) => { const r = await work(); settled = r; return r; };
    const opened = await openScope(run, captureClient, { warn }, 1000);
    if (!opened.ok) throw new Error('expected ok');
    opened.value.commit();                          // even a prior commit() is overridden by the backstop
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not disposed within 1000ms'));
    expect(settled?.ok).toBe(false);                // forced default-deny rollback (sentinel), not commit
  });

  it('normal dispose before elapse clears the timer (no spurious warn)', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }, 1000);
    if (!opened.ok) throw new Error('expected ok');
    opened.value.commit();
    await opened.value[Symbol.asyncDispose]();
    await vi.advanceTimersByTimeAsync(5000);        // long past the timeout
    expect(warn).not.toHaveBeenCalled();
  });

  it('late dispose after the backstop fired is idempotent (no throw, no second warn)', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }, 1000);
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(opened.value[Symbol.asyncDispose]()).resolves.toBeUndefined(); // no throw
    expect(warn).toHaveBeenCalledTimes(1);          // no second warn (already settled via sentinel)
  });

  it('a non-finite disposeTimeoutMs (Infinity) arms no timer', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }, Number.POSITIVE_INFINITY);
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(warn).not.toHaveBeenCalled();
    await opened.value[Symbol.asyncDispose]();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit transaction-scope.test.ts`
Expected: FAIL — `openScope` takes 3 args, so the 4th-arg calls arm no timer; "fires on elapse" and "late dispose" fail (no warn ever emitted). The `not.toHaveBeenCalled` tests pass vacuously, which is fine.

- [ ] **Step 3: Implement the backstop**

In `packages/core/src/transaction-scope.ts`, add the 4th parameter and the timer. The signature:

```ts
export async function openScope<TClient>(
  runNewTransaction: (work: () => Promise<Result<void, symbol>>) => Promise<Result<void, symbol | DrizzleTxError>>,
  captureClient: () => TClient,
  logger: TxLogger,
  disposeTimeoutMs?: number,
): Promise<Result<TransactionScope<TClient>, DrizzleTxError>> {
```

Then, in the block after `capturedClient` is confirmed defined (i.e. where the `scope` object is built and returned), declare the timer handle, reference it in dispose, and arm it just before returning:

```ts
  let backstop: ReturnType<typeof setTimeout> | undefined;

  const scope: TransactionScope<TClient> = {
    tx: capturedClient,
    commit: () => { outcome = 'commit'; },
    rollback: () => { outcome = 'rollback'; },
    [Symbol.asyncDispose]: async () => {
      if (backstop !== undefined) clearTimeout(backstop);   // normal dispose disarms the backstop
      releaseGate();
      const result = await settled;
      if (!result.ok && result.error !== SCOPE_ROLLBACK) {
        logger.warn(`transaction scope failed to settle: ${String(result.error)}`);
      }
    },
  };

  // R5 backstop (ADR-0014): opt-in, default OFF. On fire, do what a forgotten dispose would —
  // force default-deny rollback + release the connection + warn loudly. Never throws.
  if (disposeTimeoutMs !== undefined && Number.isFinite(disposeTimeoutMs)) {
    backstop = setTimeout(() => {
      outcome = 'rollback';                                 // override any prior commit() — leak reclaim
      releaseGate();                                        // settles the parked work → adapter ROLLBACK + release
      logger.warn(
        `transaction scope not disposed within ${disposeTimeoutMs}ms — forced rollback; ` +
          'use `await using` to guarantee disposal (this backstop reclaims a forgotten connection, ' +
          'it is not a work deadline).',
      );
    }, disposeTimeoutMs);
    backstop.unref?.();                                      // never keep the event loop alive for the backstop
  }

  return ok(scope);
```

(The early-return path — client never captured — is untouched: the tx already ended, so there is nothing to arm.)

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm exec vitest run --project core-unit transaction-scope.test.ts`
Expected: PASS — all five backstop tests plus the pre-existing `openScope` tests (unchanged 3-arg behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transaction-scope.ts packages/core/test/unit/transaction-scope.test.ts
git commit -m "feat(core): opt-in disposeTimeoutMs leak backstop on the await using scope (R5, ADR-0014)"
```

---

### Task 2: Wire `begin` + `TransactionManagerOptions` + `BeginOptions`

**Files:**
- Modify: `packages/core/src/options.ts`, `packages/core/src/transaction-manager.ts`, `packages/core/src/index.ts`, `packages/nestjs/src/transaction-host.ts`
- Test: `packages/core/test/unit/transaction-manager.test.ts`

**Depends on Task 1.** Resolve the per-call vs manager-default timeout and forward it; export the new option type; keep nestjs in parity.

- [ ] **Step 1: Write the failing resolution test**

Add to `packages/core/test/unit/transaction-manager.test.ts` (uses the NoOp adapter + fake timers — no DB; the manager's `#logger` is where the backstop warn lands):

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { NoOpDrizzleAdapter } from '../../src/adapters/noop.js';
import { TransactionManager } from '../../src/transaction-manager.js';

afterEach(() => { vi.useRealTimers(); });

it('begin() uses the manager-default disposeTimeoutMs; a per-call value overrides it', async () => {
  vi.useFakeTimers();
  const warn = vi.fn();
  const m = new TransactionManager<{}>(
    new NoOpDrizzleAdapter({}, { quiet: true }),
    { logger: { warn }, disposeTimeoutMs: 1000 },
  );

  const opened = await m.begin();                 // inherits the manager default (1000)
  if (!opened.ok) throw new Error('expected ok');
  await vi.advanceTimersByTimeAsync(1000);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('1000ms'));

  warn.mockClear();
  const opened2 = await m.begin({ disposeTimeoutMs: 200 }); // per-call overrides the default
  if (!opened2.ok) throw new Error('expected ok');
  await vi.advanceTimersByTimeAsync(200);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('200ms'));
});

it('begin() with no manager default and no per-call value arms no backstop', async () => {
  vi.useFakeTimers();
  const warn = vi.fn();
  const m = new TransactionManager<{}>(new NoOpDrizzleAdapter({}, { quiet: true }), { logger: { warn } });
  const opened = await m.begin();
  if (!opened.ok) throw new Error('expected ok');
  await vi.advanceTimersByTimeAsync(1_000_000);
  expect(warn).not.toHaveBeenCalled();
  await opened.value[Symbol.asyncDispose]();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit transaction-manager.test.ts`
Expected: FAIL — `TransactionManagerOptions` has no `disposeTimeoutMs` (TS error in the test) and `begin` ignores any timeout, so no warn fires.

- [ ] **Step 3: Add `BeginOptions`, the manager option, and the resolution**

In `packages/core/src/options.ts`:

```ts
/** Options for `begin()` / `await using`: the SQL `TxOptions` plus scope-lifecycle controls. */
export interface BeginOptions extends TxOptions {
  /** Leak backstop (ADR-0014 R5): if the scope is not disposed within this many ms, force a
   *  default-deny rollback + release + loud warn. Default OFF (unset / non-finite = no backstop).
   *  A reclaim for a FORGOTTEN scope — not a work deadline; prefer `await using` so it never fires. */
  readonly disposeTimeoutMs?: number;
}
```

In `packages/core/src/transaction-manager.ts` — add the manager option + field, and resolve in `begin`:

```ts
export interface TransactionManagerOptions {
  readonly logger?: TxLogger;
  /** Default `disposeTimeoutMs` for every `begin()` scope (per-call `begin({ disposeTimeoutMs })`
   *  overrides). Default OFF. See ADR-0014 R5. */
  readonly disposeTimeoutMs?: number;
}

// in the class:
readonly #disposeTimeoutMs: number | undefined;
// in the constructor body:
this.#disposeTimeoutMs = options?.disposeTimeoutMs;

// begin — accept BeginOptions, resolve per-call ?? manager default, forward to openScope:
begin(options?: BeginOptions): Promise<Result<TransactionScope<TClient>, DrizzleTxError>> {
  const disposeTimeoutMs = options?.disposeTimeoutMs ?? this.#disposeTimeoutMs;
  return openScope<TClient>(
    (work) => this.#newTransaction<void, symbol>(options, work),
    () => this.getTransactionClient(),
    this.#logger,
    disposeTimeoutMs,
  );
}
```

Import `BeginOptions` from `./options.js` (alongside the existing `TxOptions` import). Passing `options` (a `BeginOptions`) to `#newTransaction(options: TxOptions | undefined, …)` is sound — `BeginOptions extends TxOptions`, and the extra `disposeTimeoutMs` key is ignored by the adapter's BEGIN construction (which reads only `isolationLevel`/`accessMode`/`deferrable`).

In `packages/core/src/index.ts` — **replace the whole existing options export line** (line 18, currently `export type { TxOptions, IsolationLevel, AccessMode } from './options.js';`) with one that adds `BeginOptions` (don't append a second line — that would double-export `TxOptions`):

```ts
export type { TxOptions, BeginOptions, IsolationLevel, AccessMode } from './options.js';
```

- [ ] **Step 4: nestjs parity (mechanical)**

In `packages/nestjs/src/transaction-host.ts`: change `begin(options?: TxOptions)` → `begin(options?: BeginOptions)` and add `BeginOptions` to the `@drizzle-tx/core` type import (drop `TxOptions` if now unused, else keep). Body unchanged (`return this.#manager.begin(options);`).

- [ ] **Step 5: Run tests + typecheck to verify pass**

Run: `pnpm exec vitest run --project core-unit transaction-manager.test.ts`
Expected: PASS — per-call overrides manager default; no-config arms nothing.
Run: `pnpm build && pnpm typecheck`
Expected: PASS — `BeginOptions` resolves everywhere; `create-drizzle-tx.ts`'s indexed `begin` type auto-follows; nestjs host compiles with the new signature.

- [ ] **Step 6: Add the R5 real-connection-reclaim integration test**

Add to `packages/core/test/integration/transaction-scope.integration.test.ts` (uses the file's existing harness — mirror a neighbouring test's `TransactionManager`/`DrizzleAdapter` setup; `createTestDb(max)` accepts a pool max and sets `connectionTimeoutMillis: 3000`). **Add `import { ok } from '../../src/result.js';`** at the top — this file does not currently import `ok` and no neighbouring test provides it.

```ts
it('R5: an un-disposed scope is reclaimed after disposeTimeoutMs (connection released)', async () => {
  const small = await createTestDb(1); // pool max 1 → the scope holds the ONLY connection
  const m = new TransactionManager(new DrizzleAdapter({ db: small.db }), { logger: { warn: () => {} } });
  try {
    const opened = await m.begin({ disposeTimeoutMs: 500 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // Deliberately DO NOT dispose — simulate a forgotten scope pinning the connection.
    // The backstop (500ms) fires < the pool's 3s connectionTimeout, freeing the connection so a
    // fresh tx can acquire it instead of deadlocking:
    const r = await m.withTransaction(async () => ok('reclaimed'));
    expect(r).toEqual({ ok: true, value: 'reclaimed' });
  } finally {
    await small.close();
  }
}, 10000);
```

Run: `pnpm exec vitest run --project core-integration transaction-scope.integration.test.ts` (Docker)
Expected: PASS — the forgotten scope's connection is reclaimed by the backstop and the follow-up `withTransaction` succeeds (would time out / deadlock without the backstop).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/options.ts packages/core/src/transaction-manager.ts packages/core/src/index.ts \
        packages/nestjs/src/transaction-host.ts packages/core/test/unit/transaction-manager.test.ts \
        packages/core/test/integration/transaction-scope.integration.test.ts
git commit -m "feat(core): resolve disposeTimeoutMs (per-begin + manager default); nestjs parity + R5 reclaim test (ADR-0014)"
```

---

### Task 3: Docs — E1 two-primitive split + E6 commit-failure note + backstop framing

**Files:**
- Modify: `packages/core/README.md`, `CONTEXT.md`
- Modify: `packages/core/src/transaction-manager.ts` (extend the `begin` JSDoc)

**Depends on Task 2.** ADR-0014's E1/E6 are **docs-only** decisions (no `scope.outcome`, no new primitive).

- [ ] **Step 1: README — the two-primitive split, loudly (E1)**

In `packages/core/README.md`, add a section contrasting the two primitives (from ADR-0014's table): `withTransaction(work)` = callback, **implicit** propagation (the injected `db` proxy auto-joins) — the default and the flagship path; `begin()`/`await using` = block scope, **explicit** `scope.tx` (no auto-join), the advanced escape hatch. State plainly that **choosing the scope opts out of implicit propagation**. Add the `disposeTimeoutMs` note: opt-in, default OFF, framed as a **leak backstop that reclaims a forgotten connection, not a work deadline**; the primary defense is `await using` (guarantees disposal), never a bare `begin()`.

- [ ] **Step 2: README/JSDoc — commit-failure reactability (E6)**

Extend the `begin` JSDoc in `transaction-manager.ts` (it already carries the R1 note) with the E6 escape: a scope commit that fails at dispose is **logged, not returned** — *use `withTransaction` when you need to react to a commit failure as a `Result`*. Mirror one line in the README scope section.

- [ ] **Step 3: CONTEXT.md — ubiquitous language**

Add the two-primitive split to `CONTEXT.md` as vocabulary: **callback primitive** (`withTransaction`, implicit propagation) vs **scope primitive** (`begin`/`await using`, explicit `scope.tx`). Keep it terminology-only (CONTEXT.md is the naming source of truth).

- [ ] **Step 4: Commit**

```bash
git add packages/core/README.md CONTEXT.md packages/core/src/transaction-manager.ts
git commit -m "docs(core): two-primitive split (E1) + commit-failure reactability (E6) + backstop framing (ADR-0014)"
```

---

### Task 4: Final gate

**Files:** none (verification only).

- [ ] **Step 1: Full build + typecheck + test + publish check**

Run: `pnpm build`
Expected: PASS — core (tsdown dual ESM+CJS), nestjs (tsc CJS).
Run: `pnpm typecheck`
Expected: PASS — `BeginOptions` resolves; the indexed `begin`/factory types follow; nestjs host compiles.
Run: `pnpm test` (unit + core-integration + nestjs; Docker)
Expected: PASS — the backstop unit tests, the resolution test, and the R5 reclaim integration test all green; **every pre-existing test unchanged** (default-OFF = zero behavior change).
Run: `pnpm -r run check:publish`
Expected: PASS — `attw` + `publint --strict`; `BeginOptions` resolves in ESM + CJS.

- [ ] **Step 2: Confirm zero behavior change for existing callers**

Sanity: no test outside the new backstop/resolution/reclaim cases changed. A `begin()` with neither a manager default nor a per-call value arms no timer (grep the diff: the only new runtime path is guarded by `disposeTimeoutMs !== undefined && Number.isFinite(...)`).

---

## Downstream (later plans — NOT in this plan)

- **`scope.outcome`** (E6 awaitable commit-failure channel) is **deferred** by ADR-0014 — not built here; the docs point commit-failure reactors to `withTransaction`. It slots behind the same scope object later if demand appears.
- **Plan E** (T1 concurrency / ALS-isolation, T3 deep-nesting, cheap fixes R4/E7/T5/Q1/Q3) is the remaining core-quality plan; independent of this one.
- The two-primitive positioning documented here (callback = flagship path) is the premise the **flagship Next.js/tRPC adapters** (#12–#14) build on.
