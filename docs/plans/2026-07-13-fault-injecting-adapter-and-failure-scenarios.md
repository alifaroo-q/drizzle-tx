# Fault-Injecting Testing Adapter + Failure-Scenario Coverage (Plan B) — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use the repo's available execution skill when one exists (for example, `executing-plans` or `tdd`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `FaultInjectingDrizzleAdapter` + SQLSTATE/socket error-shape helpers, shipped from `@drizzle-tx/core/testing`, reproducing drizzle's exact commit/rollback **shadowing** so the ADR-0012 error model is exercisable in-process (no Docker fault injection); then land the **T2 failure-scenario coverage matrix** against it; then sharpen the NoOp false-pass signal (T4a, docs).

**Architecture:** A **sibling** class to `NoOpDrizzleAdapter` (not a subclass — ADR-0007 keeps NoOp minimal). It implements `TransactionAdapter` with one caller-supplied client and issues **no** real SQL — it throws *where* BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE/ROLLBACK-TO-SAVEPOINT would run. Error helpers hand-roll the pg `DatabaseError` / socket shapes structurally (**no `pg` import**) so the values classify through the existing `classifyCaught` cause-chain walk (`rollback-boundary.ts`). Injection is **declarative per-phase, sticky by default**, with a fluent mid-test API and a `times` one-shot.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly` — no constructor parameter properties, explicit fields), Vitest 4, tsdown dual ESM+CJS (the `./testing` subpath already builds to `dist/testing.{js,cjs,d.ts,d.cts}`). **No Docker** — every test here is a `core-unit` test (the fault adapter replaces the DB).

**Source of truth:** [Spec: failure-injecting /testing adapter](../drizzle-tx/specs/failure-injecting-testing-adapter.md) (#28) — the injection API, helpers, the shadowing boundary, the T4a callout, and the five worked acceptance examples. Error model it injects against: [ADR-0012](../adr/0012-structured-transaction-failure-error-model.md) (already implemented — Plan A). ADR-0007 (the `/testing` observable-no-op precedent).

**Depends on:** Plan A (landed — commits `82003d4`→`de690de`). Verified against current code: `classifyCaught(e, lostDomainError?)` walks the `.cause` chain (depth 8) and keys off a 5-char string `.code` + string `.severity` for SQLSTATE, and `.syscall`/socket-code/`"Connection terminated"` for socket loss (`rollback-boundary.ts`); the manager records `inFlight` and calls `classifyRollback(e, inFlight)` from one `#runInBoundary`.

**Assumptions:**
- **Adapter + helpers live in one file** `packages/core/src/adapters/fault-injecting.ts` (~180 LOC adapter + ~40 LOC helpers < 300 LOC; both are `/testing`-only and intrinsically paired). If it later exceeds 300, split helpers into `fault-injecting-errors.ts`.
- The adapter **throws the fake error directly** (does not wrap it in a `DrizzleQueryError`). `classifyCaught` finds the markers at cause-depth 0, so a raw throw classifies identically to the real wrapped driver error. This is why the helpers need no wrapper.
- **`commit` faults are faithful to drizzle:** a COMMIT failure runs *inside* the try, so it triggers the ROLLBACK path (ADR-0012 Evidence: `begin → try{ cb; commit } → catch{ rollback; throw }`). Therefore the boundary log for a commit fault is `outcome: 'rollback', failedAt: 'commit'` (matches spec worked-example 1), and if `rollback` is *also* injected it shadows the commit error.
- **Boundary-log `failedAt` semantics:** set to the injected phase that fired. A rollback driven purely by a domain `err(E)` (no injected fault) logs `outcome: 'rollback'` with **no** `failedAt` — the fault didn't cause it.
- The adapter **warns once on construction** unless `quiet: true`, mirroring `NoOpDrizzleAdapter` (message contains "fault injection enabled — testing only").

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/adapters/fault-injecting.ts` | The adapter + error-shape helpers | **Create** |
| `packages/core/src/testing.ts` | `/testing` barrel | **Modify** — add the new exports alongside `NoOpDrizzleAdapter` |
| `packages/core/src/adapters/noop.ts` | NoOp class JSDoc (T4a) | **Modify** — class-level JSDoc steering assertions |
| `packages/core/README.md` | `/testing` vehicle callout (T4a) | **Modify** — the 3-row "which adapter for which assertion" table |
| `packages/core/test/unit/fault-injecting.test.ts` | Adapter + helper unit tests | **Create** |
| `packages/core/test/unit/failure-scenarios.test.ts` | T2 scenario matrix | **Create** |
| `packages/core/test/types/fault-injecting.test-d.ts` | Type-level surface test | **Create** (mirror `noop.test-d.ts`) |

---

### Task 1: Error-shape helpers (`fakePgError` / `socketError` / convenience wrappers)

**Files:**
- Create: `packages/core/src/adapters/fault-injecting.ts` (helpers only in this task; adapter added in Task 2)
- Test: `packages/core/test/unit/fault-injecting.test.ts`

**Depends on:** Plan A only. **Riskiest-first rationale:** the whole adapter is worthless if its fake errors don't classify. Prove the shapes against the *real* `classifyCaught` before building anything that throws them.

- [ ] **Step 1: Write the failing helper tests**

Create `packages/core/test/unit/fault-injecting.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyCaught } from '../../src/rollback-boundary.js';
import {
  fakePgError, socketError, pgSerializationFailure, pgDeadlock, pgAdminShutdown,
} from '../../src/adapters/fault-injecting.js';

describe('fault-injecting error helpers', () => {
  it('fakePgError carries a 5-char code + string severity (classifies structurally)', () => {
    const e = fakePgError('23505', 'dup key');
    expect(e).toMatchObject({ code: '23505', message: 'dup key', severity: expect.any(String) });
    // structural markers present → classifyCaught reads the SQLSTATE:
    expect(classifyCaught(e)).toMatchObject({ kind: 'TransactionAborted', sqlState: '23505' });
  });

  it('pgSerializationFailure → SerializationFailure(40001)', () => {
    expect(classifyCaught(pgSerializationFailure())).toMatchObject({ kind: 'SerializationFailure', sqlState: '40001' });
  });

  it('pgDeadlock → DeadlockDetected(40P01)', () => {
    expect(classifyCaught(pgDeadlock())).toMatchObject({ kind: 'DeadlockDetected', sqlState: '40P01' });
  });

  it('pgAdminShutdown → ConnectionLost(57P01)', () => {
    expect(classifyCaught(pgAdminShutdown())).toMatchObject({ kind: 'ConnectionLost', sqlState: '57P01' });
  });

  it('socketError() (code-less) → ConnectionLost with undefined sqlState', () => {
    const e = socketError();
    expect(e).toBeInstanceOf(Error);
    expect((e as { code?: unknown }).code).toBeUndefined();
    expect(classifyCaught(e)).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
  });

  it('socketError({ code: "ECONNRESET" }) → ConnectionLost via socket-first precedence', () => {
    const e = socketError({ code: 'ECONNRESET' });
    expect((e as { syscall?: unknown }).syscall).toBeDefined();
    expect(classifyCaught(e)).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit fault-injecting.test.ts`
Expected: FAIL — `../../src/adapters/fault-injecting.js` does not exist (module resolution error).

- [ ] **Step 3: Implement the helpers**

Create `packages/core/src/adapters/fault-injecting.ts` with the helpers (adapter follows in Task 2):

```ts
/** A fake pg `DatabaseError`: a 5-char SQLSTATE `.code` + a string `.severity` — the exact
 *  structural markers `classifyCaught` reads (ADR-0012 §3). No `pg` import. */
export function fakePgError(
  code: string,
  message = `pg error ${code}`,
): { code: string; message: string; severity: string; routine: string; name: string } {
  return { code, message, severity: 'ERROR', routine: 'exec_simple_query', name: 'error' };
}

/** Code-less client-side socket loss (the drizzle/pg "Connection terminated" shape), or — when a
 *  libuv `code` is given — a raw socket error carrying `.syscall`. Both classify to ConnectionLost
 *  (socket-first precedence keeps `sqlState` undefined). */
export function socketError(opts?: { message?: string; code?: string }): Error {
  const e = new Error(opts?.message ?? 'Connection terminated unexpectedly');
  if (opts?.code) Object.assign(e, { code: opts.code, syscall: 'read' });
  return e;
}

export const pgSerializationFailure = () => fakePgError('40001', 'could not serialize access');
export const pgDeadlock = () => fakePgError('40P01', 'deadlock detected');
export const pgAdminShutdown = () => fakePgError('57P01', 'terminating connection due to administrator command');
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm exec vitest run --project core-unit fault-injecting.test.ts`
Expected: PASS for all six helper tests (each classifies to the expected variant/sqlState).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/fault-injecting.ts packages/core/test/unit/fault-injecting.test.ts
git commit -m "feat(core/testing): SQLSTATE/socket error-shape helpers for fault injection (#28)"
```

---

### Task 2: `FaultInjectingDrizzleAdapter` — new-root path + injection config

**Files:**
- Modify: `packages/core/src/adapters/fault-injecting.ts`
- Test: `packages/core/test/unit/fault-injecting.test.ts`

**Depends on Task 1.** Implements construction, the `begin`/`commit`/`rollback` phases for `wrapWithTransaction`, the boundary log with `failedAt`, `times`/sticky resolution, and the fluent `failOn`/`failOnce`/`clear`. This is the fragile core — the phase-firing + shadowing must match the spec's boundary exactly.

- [ ] **Step 1: Write the failing adapter tests (new-root)**

Append to `packages/core/test/unit/fault-injecting.test.ts`:

```ts
import { TransactionManager } from '../../src/transaction-manager.js';
import { err, ok } from '../../src/result.js';
import { FaultInjectingDrizzleAdapter } from '../../src/adapters/fault-injecting.js';

const mgr = (a: FaultInjectingDrizzleAdapter<{}>) => new TransactionManager<{}>(a, { logger: { warn() {} } });

describe('FaultInjectingDrizzleAdapter — new-root', () => {
  it('warns once on construction unless quiet', () => {
    let n = 0;
    new FaultInjectingDrizzleAdapter({}, { logger: { warn: () => { n++; } } });
    new FaultInjectingDrizzleAdapter({}, { logger: { warn: () => { n++; } }, quiet: true });
    expect(n).toBe(1);
  });

  it('clean run: work ok → commit, boundary log has no failedAt', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { quiet: true });
    const r = await mgr(a).withTransaction(async () => ok('done'));
    expect(r).toEqual({ ok: true, value: 'done' });
    expect(a.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'commit' }]);
  });

  it('COMMIT fault (40001) after ok-work → SerializationFailure, log failedAt=commit (R1)', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { failAt: { commit: pgSerializationFailure() }, quiet: true });
    const r = await mgr(a).withTransaction(async () => ok(42)); // work succeeds
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'SerializationFailure', sqlState: '40001' });
    expect(a.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'rollback', failedAt: 'commit' }]);
  });

  it('BEGIN fault → classified error, work never runs', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { failAt: { begin: pgAdminShutdown() }, quiet: true });
    let ran = false;
    const r = await mgr(a).withTransaction(async () => { ran = true; return ok(1); });
    expect(ran).toBe(false);
    expect((r as { error: { kind: string } }).error.kind).toBe('ConnectionLost');
    expect(a.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'rollback', failedAt: 'begin' }]);
  });

  it('failOnce: fails first commit, succeeds on the second call', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { quiet: true }).failOnce('commit', pgDeadlock());
    const r1 = await mgr(a).withTransaction(async () => ok('a'));
    const r2 = await mgr(a).withTransaction(async () => ok('b'));
    expect(r1.ok).toBe(false);
    expect(r2).toEqual({ ok: true, value: 'b' });
  });

  it('clear(phase) disarms an injection', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { failAt: { commit: pgDeadlock() }, quiet: true });
    a.clear('commit');
    const r = await mgr(a).withTransaction(async () => ok('x'));
    expect(r).toEqual({ ok: true, value: 'x' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit fault-injecting.test.ts`
Expected: FAIL — `FaultInjectingDrizzleAdapter` is not exported from `fault-injecting.js`.

- [ ] **Step 3: Implement the adapter (new-root path)**

Add to `packages/core/src/adapters/fault-injecting.ts` (import `TxLogger`/`consoleLogger`, `TxOptions`, `TransactionAdapter`). Model the boundary faithfully per the Assumptions:

```ts
import { consoleLogger, type TxLogger } from '../logger.js';
import type { TxOptions } from '../options.js';
import type { TransactionAdapter } from './port.js';

export type TxPhase =
  | 'begin' | 'commit' | 'rollback'
  | 'savepoint' | 'release-savepoint' | 'rollback-to-savepoint';

export interface FaultInjection { readonly error: unknown; readonly times?: number; }

export interface FaultInjectingDrizzleAdapterOptions {
  readonly logger?: TxLogger;
  readonly quiet?: boolean;
  readonly failAt?: Partial<Record<TxPhase, unknown | FaultInjection>>;
}

export interface FaultBoundaryLogEntry {
  readonly kind: 'new-root' | 'nested';
  readonly outcome: 'commit' | 'rollback';
  readonly failedAt?: TxPhase;
}

const isInjection = (v: unknown): v is FaultInjection =>
  typeof v === 'object' && v !== null && 'error' in v;

interface Armed { error: unknown; remaining: number; }

export class FaultInjectingDrizzleAdapter<TClient> implements TransactionAdapter<TClient> {
  readonly #client: TClient;
  readonly #armed = new Map<TxPhase, Armed>();
  #boundaryLog: FaultBoundaryLogEntry[] = [];
  readonly supportsIndependentTransactions = true;

  constructor(client: TClient, options?: FaultInjectingDrizzleAdapterOptions) {
    this.#client = client;
    const logger = options?.logger ?? consoleLogger;
    if (!options?.quiet) logger.warn('FaultInjectingDrizzleAdapter: fault injection enabled — testing only.');
    for (const [phase, v] of Object.entries(options?.failAt ?? {})) this.#arm(phase as TxPhase, v);
  }

  getBaseClient(): TClient { return this.#client; }
  getBoundaryLog(): readonly FaultBoundaryLogEntry[] { return this.#boundaryLog; }
  resetBoundaryLog(): void { this.#boundaryLog = []; }

  failOn(phase: TxPhase, error: unknown): this { this.#arm(phase, error); return this; }
  failOnce(phase: TxPhase, error: unknown): this { this.#arm(phase, { error, times: 1 }); return this; }
  clear(phase?: TxPhase): this { if (phase) this.#armed.delete(phase); else this.#armed.clear(); return this; }

  wrapWithTransaction<T>(_o: TxOptions | undefined, work: (tx: TClient) => Promise<T>): Promise<T> {
    return this.#boundary('new-root', 'begin', 'commit', 'rollback', work);
  }
  wrapWithNestedTransaction<T>(_p: TClient, work: (sp: TClient) => Promise<T>): Promise<T> {
    return this.#boundary('nested', 'savepoint', 'release-savepoint', 'rollback-to-savepoint', work);
  }

  #arm(phase: TxPhase, v: unknown | FaultInjection): void {
    const inj = isInjection(v) ? v : { error: v, times: Number.POSITIVE_INFINITY };
    this.#armed.set(phase, { error: inj.error, remaining: inj.times ?? Number.POSITIVE_INFINITY });
  }

  /** Peek+consume: returns the injected error if this phase is armed with remaining > 0, else undefined. */
  #take(phase: TxPhase): unknown | undefined {
    const a = this.#armed.get(phase);
    if (!a || a.remaining <= 0) return undefined;
    a.remaining -= 1;
    if (a.remaining <= 0) this.#armed.delete(phase);
    return a.error;
  }

  async #boundary<T>(
    kind: FaultBoundaryLogEntry['kind'],
    pre: TxPhase, post: TxPhase, undo: TxPhase,
    work: (c: TClient) => Promise<T>,
  ): Promise<T> {
    // PRE (BEGIN / SAVEPOINT) — before work; a fault here means work never runs.
    const preErr = this.#take(pre);
    if (preErr !== undefined) { this.#log(kind, 'rollback', pre); throw preErr; }

    let injectedAt: TxPhase | undefined;
    try {
      const value = await work(this.#client);
      const postErr = this.#take(post);           // POST (COMMIT / RELEASE) runs inside the try (drizzle)
      if (postErr !== undefined) { injectedAt = post; throw postErr; }
      this.#log(kind, 'commit');
      return value;
    } catch (e) {
      // UNDO (ROLLBACK / ROLLBACK TO SAVEPOINT) — may itself be injected → shadows e (R2 path).
      const undoErr = this.#take(undo);
      if (undoErr !== undefined) { this.#log(kind, 'rollback', undo); throw undoErr; }
      this.#log(kind, 'rollback', injectedAt);     // injectedAt set only if the POST fault fired
      throw e;
    }
  }

  #log(kind: FaultBoundaryLogEntry['kind'], outcome: 'commit' | 'rollback', failedAt?: TxPhase): void {
    this.#boundaryLog.push(failedAt ? { kind, outcome, failedAt } : { kind, outcome });
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm exec vitest run --project core-unit fault-injecting.test.ts`
Expected: PASS for all new-root tests (clean commit, commit-fault R1, begin-fault, failOnce one-shot, clear).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/fault-injecting.ts packages/core/test/unit/fault-injecting.test.ts
git commit -m "feat(core/testing): FaultInjectingDrizzleAdapter new-root phase injection (#28)"
```

---

### Task 3: Nested/savepoint path + R2 shadowing (both levels)

**Files:**
- Test: `packages/core/test/unit/fault-injecting.test.ts` (behavior already implemented in Task 2's `#boundary` — this task proves the nested + shadow paths)

**Depends on Task 2.** The `#boundary` helper already parameterizes pre/post/undo, so `wrapWithNestedTransaction` fires `savepoint`/`release-savepoint`/`rollback-to-savepoint`. This task's tests prove the **R2 shadowing** (domain `err(E)` + a failing UNDO → infra error wins, `lostDomainError` preserved) at both the new-root and savepoint levels — the whole reason the adapter exists.

- [ ] **Step 1: Write the failing R2 / nested tests**

Append to `packages/core/test/unit/fault-injecting.test.ts`:

```ts
// NOTE: `socketError` is already imported in Task 1's block at the top of this file — do NOT
// re-import it here (duplicate `const` declaration is a SyntaxError). Only `Propagation` is new.
import { Propagation } from '../../src/propagation.js';

describe('FaultInjectingDrizzleAdapter — R2 shadowing + nested', () => {
  it('domain err + ROLLBACK fault → infra wins, domain E preserved in lostDomainError', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { failAt: { rollback: pgAdminShutdown() }, quiet: true });
    const r = await mgr(a).withTransaction(async () => err({ kind: 'NotFound' } as const));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'ConnectionLost', sqlState: '57P01', lostDomainError: { kind: 'NotFound' } });
    expect(a.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'rollback', failedAt: 'rollback' }]);
  });

  it('domain err + successful rollback (no fault) → domain E returned faithfully, no lostDomainError', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { quiet: true });
    const r = await mgr(a).withTransaction(async () => err({ kind: 'SoldOut' } as const));
    expect(r).toEqual({ ok: false, error: { kind: 'SoldOut' } });
    expect(a.getBoundaryLog()).toEqual([{ kind: 'new-root', outcome: 'rollback' }]); // no failedAt
  });

  it('NESTED: ROLLBACK TO SAVEPOINT fault (socket) → ConnectionLost, undefined sqlState, E preserved', async () => {
    // Outer REQUIRED joins nothing yet; run an outer tx, then a NESTED child that errs while its
    // savepoint-rollback is faulted. The child boundary is the 'nested' entry.
    const a = new FaultInjectingDrizzleAdapter({}, { failAt: { 'rollback-to-savepoint': socketError() }, quiet: true });
    const m = mgr(a);
    const r = await m.withTransaction(async () =>
      m.withTransaction(Propagation.Nested, async () => err({ kind: 'BadChild' } as const)),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined, lostDomainError: { kind: 'BadChild' } });
    // the nested boundary logged the savepoint-rollback fault:
    expect(a.getBoundaryLog().some((e) => e.kind === 'nested' && e.failedAt === 'rollback-to-savepoint')).toBe(true);
  });

  it('SAVEPOINT fault → nested work never runs', async () => {
    const a = new FaultInjectingDrizzleAdapter({}, { failAt: { savepoint: pgAdminShutdown() }, quiet: true });
    const m = mgr(a);
    let childRan = false;
    await m.withTransaction(async () =>
      m.withTransaction(Propagation.Nested, async () => { childRan = true; return ok(1); }),
    );
    expect(childRan).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `pnpm exec vitest run --project core-unit fault-injecting.test.ts`
Expected: PASS on first run **if** Task 2's `#boundary` is correct (nested path is the same helper with savepoint phases; R2 shadowing is the `undoErr` branch feeding the manager's `inFlight` stash). If any nested test FAILS, the bug is in Task 2's `#boundary` (e.g. `injectedAt`/`failedAt` wiring or the `#take(undo)` shadow branch) — fix there, not in the test. **Note:** these tests assert manager-level behavior (`lostDomainError`) that only works because Plan A's `#runInBoundary` records `inFlight` — a green result here is the end-to-end R2 proof.

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/unit/fault-injecting.test.ts
git commit -m "test(core/testing): R2 shadowing + nested savepoint fault injection (#28)"
```

---

### Task 4: Wire the `/testing` barrel + type surface + publish check

**Files:**
- Modify: `packages/core/src/testing.ts`
- Create: `packages/core/test/types/fault-injecting.test-d.ts`

**Depends on Tasks 1–3.**

- [ ] **Step 1: Add the exports to the `/testing` barrel**

Append to `packages/core/src/testing.ts` (keep the existing NoOp exports):

```ts
export {
  FaultInjectingDrizzleAdapter,
  type FaultInjectingDrizzleAdapterOptions,
  type FaultInjection,
  type FaultBoundaryLogEntry,
  type TxPhase,
  fakePgError,
  socketError,
  pgSerializationFailure,
  pgDeadlock,
  pgAdminShutdown,
} from './adapters/fault-injecting.js';
```

- [ ] **Step 2: Add a type-level surface test (mirror `noop.test-d.ts`)**

Create `packages/core/test/types/fault-injecting.test-d.ts`:

```ts
import { FaultInjectingDrizzleAdapter, type TxPhase } from '../../src/adapters/fault-injecting.js';

type TestClient = { readonly tag: 'client'; query(sql: string): Promise<number> };
declare const client: TestClient;

const a = new FaultInjectingDrizzleAdapter(client, { failAt: { commit: new Error('x') }, quiet: true });
const base: TestClient = a.getBaseClient();
void base;

// fluent API returns `this` (chainable) and the client type is preserved through the seam:
a.failOn('rollback', new Error('y')).failOnce('begin', new Error('z')).clear();
a.wrapWithTransaction(undefined, async (tx) => { const t: TestClient = tx; return t.query('select 1'); });

// TxPhase is the 6-member union (a wrong literal is rejected):
const p: TxPhase = 'rollback-to-savepoint';
void p;
// @ts-expect-error — not a valid phase
const bad: TxPhase = 'COMMIT';
void bad;
```

- [ ] **Step 3: Typecheck + build + publish check**

Run: `pnpm build`
Expected: PASS — tsdown emits `dist/testing.{js,cjs,d.ts,d.cts}` including the new adapter/helpers.
Run: `pnpm typecheck`
Expected: PASS — incl. `fault-injecting.test-d.ts` (`@ts-expect-error` on the bad phase consumed).
Run: `pnpm -r run check:publish`
Expected: PASS — `attw` + `publint --strict` resolve the `./testing` subpath in both ESM and CJS with the new exports.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/testing.ts packages/core/test/types/fault-injecting.test-d.ts
git commit -m "feat(core/testing): export FaultInjectingDrizzleAdapter + error helpers from ./testing (#28)"
```

---

### Task 5: T2 — the failure-scenario coverage matrix

**Files:**
- Create: `packages/core/test/unit/failure-scenarios.test.ts`

**Depends on Task 4.** The audit-04 **T2** deliverable: a single, legible file that asserts the ADR-0012 classification for **every** named variant at the phases that produce it, plus the R1/R2 contracts — the scenario coverage that line coverage masks (Synthesis #25). Uses the now-exported `/testing` surface (import from the built path style the repo uses in tests — direct `../../src` imports).

- [ ] **Step 1: Write the scenario matrix**

Create `packages/core/test/unit/failure-scenarios.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  FaultInjectingDrizzleAdapter, fakePgError, socketError,
} from '../../src/adapters/fault-injecting.js';
import { err, ok } from '../../src/result.js';
import { TransactionManager } from '../../src/transaction-manager.js';

const run = (failAt: Record<string, unknown>, work: () => Promise<any>) =>
  new TransactionManager<{}>(
    new FaultInjectingDrizzleAdapter({}, { failAt: failAt as any, quiet: true }),
    { logger: { warn() {} } },
  ).withTransaction(work);

describe('T2: failure-scenario classification matrix', () => {
  // Each SQLSTATE surfaces as its variant regardless of whether it fires at COMMIT or ROLLBACK.
  it.each([
    ['40001', 'SerializationFailure'],
    ['40P01', 'DeadlockDetected'],
    ['08006', 'ConnectionLost'],
    ['57P03', 'ConnectionLost'],
    ['23505', 'TransactionAborted'], // unique_violation — residual, but sqlState carried
  ])('COMMIT fails with %s → %s (sqlState carried)', async (code, kind) => {
    const r = await run({ commit: fakePgError(code) }, async () => ok('work-ok'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind, sqlState: code });
  });

  it('R1: ok-returning work still errs when COMMIT fails', async () => {
    const r = await run({ commit: fakePgError('40001') }, async () => ok(123));
    expect(r.ok).toBe(false); // documented contract (ADR-0012 R1)
  });

  it('R2: domain err + ROLLBACK double-fault → infra wins, lostDomainError preserved', async () => {
    const r = await run({ rollback: fakePgError('57P01') }, async () => err({ kind: 'DomainX' } as const));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'ConnectionLost', sqlState: '57P01', lostDomainError: { kind: 'DomainX' } });
  });

  it('conn-loss: code-less socket teardown at commit → ConnectionLost, undefined sqlState', async () => {
    const r = await run({ commit: socketError() }, async () => ok('x'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
  });

  it('clean commit path is unaffected by an unrelated armed phase', async () => {
    // a rollback fault must NOT fire when work commits cleanly
    const r = await run({ rollback: fakePgError('40001') }, async () => ok('committed'));
    expect(r).toEqual({ ok: true, value: 'committed' });
  });
});
```

- [ ] **Step 2: Run test to verify pass**

Run: `pnpm exec vitest run --project core-unit failure-scenarios.test.ts`
Expected: PASS — the full matrix (5-way SQLSTATE→variant at commit, R1, R2 with `lostDomainError`, socket conn-loss, clean-path-no-false-fire).

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/unit/failure-scenarios.test.ts
git commit -m "test(core): T2 failure-scenario classification matrix via FaultInjectingDrizzleAdapter"
```

---

### Task 6: T4a — sharpen the NoOp false-pass signal (docs) + final gate

**Files:**
- Modify: `packages/core/src/adapters/noop.ts` (class JSDoc)
- Modify: `packages/core/README.md` (the `/testing` vehicle table)

**Depends on Tasks 1–5.** Docs-only, no behavior change (per the spec's T4a section).

- [ ] **Step 1: Add the NoOp class-level JSDoc**

Add above `export class NoOpDrizzleAdapter` in `packages/core/src/adapters/noop.ts` (spec text, verbatim intent):

```ts
/** Asserts propagation **decisions** via `getBoundaryLog()` — which boundaries were entered and
 *  their commit/rollback outcome. It does **not** issue SQL, persist data, or roll back mutations:
 *  `err(...)` yields a faithful `Result`, but the mock client is simply never changed. **Do not
 *  assert data effects or failure classification against this adapter** — a "rolled back"
 *  assertion on mutated mock state false-passes. For data-effect assertions use real Postgres;
 *  for failure / `DrizzleTxError` classification use `FaultInjectingDrizzleAdapter`. */
```

- [ ] **Step 2: Add the README `/testing` vehicle callout**

In `packages/core/README.md`, **add a new `## Testing` section** (the README currently has none — don't hunt for one to extend) containing the 3-row steering table from the spec:

```markdown
### Which testing adapter for which assertion

| Want to assert… | Use |
|---|---|
| which propagation boundary was taken (wiring) | `NoOpDrizzleAdapter` + `getBoundaryLog()` |
| a `DrizzleTxError` variant / SQLSTATE classification | `FaultInjectingDrizzleAdapter` + `fakePgError` |
| real commit/rollback **data** effects | real Postgres (Testcontainers) |
```

- [ ] **Step 3: Final full gate**

Run: `pnpm build`
Expected: PASS (both packages).
Run: `pnpm typecheck`
Expected: PASS (all `*.test-d.ts` incl. the new fault-injecting surface test).
Run: `pnpm test:unit`
Expected: PASS — the full core-unit suite incl. `fault-injecting.test.ts` + `failure-scenarios.test.ts`, no regressions.
Run: `pnpm -r run check:publish`
Expected: PASS — `./testing` subpath clean in ESM + CJS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/adapters/noop.ts packages/core/README.md
git commit -m "docs(core/testing): T4a — steer assertions to the right adapter; NoOp false-pass callout (#28)"
```

---

## Downstream (later plans — NOT in this plan)

- **T2 real-DB slice already covered:** the deferred-constraint COMMIT-failure integration test landed in **Plan A** (Task 4). The remaining T2 scenarios are all fault-adapter unit tests (this plan) — no Docker.
- **Plan C** (brand + export surface, #31/#32) and **Plan E** (T1 concurrency + T3 deep-nesting + cheap fixes) are independent of this plan.
- **`@drizzle-tx/nestjs/testing`** fault-injecting parity is explicitly out of scope (#28 spec — follow only if demand appears).
