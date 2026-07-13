# Concurrency/Nesting Coverage + Cheap Fixes (Plan E) — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use the repo's available execution skill when one exists (for example, `executing-plans` or `tdd`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last core-quality gaps before the flagship: **T1** assert the library's central correctness property — concurrent-request ALS isolation — which currently has *no test at all*; **T3** cover deep-nesting propagation compositions (depth ≥2); and land the cheap fixes **R4** (PoolConnectionTimeout carries the real timeout, not `undefined`), **E7** (the two agreed naming cleanups), **T5** (a coverage-threshold CI gate), **Q1** (lower the Node floor to the true `await using` floor), **Q3** (`STABILITY.md`).

**Architecture:** T1/T3 are **characterization tests** — they assert properties the current engine should already satisfy; a failure is a real bug to stop on, not a red-green step. ALS isolation is proven two ways: a **unit** test with a fake adapter that hands a *distinct* client per boundary (proves `AsyncLocalStorage.run()` doesn't bleed across concurrent async flows — no DB), and an **integration** test with real Postgres (proves true transactional isolation + the auto-joining proxy picks the right tx under concurrency). R4 is a genuine bug fix (TDD). E7 is a mechanical rename + JSDoc. T5/Q1/Q3 are packaging/policy.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly`), Vitest 4 (v8 coverage), tsdown dual ESM+CJS (core) / tsc CJS (nestjs), real Postgres via Testcontainers (`createTestDb(max?)`, database-per-worker).

**Source of truth:** audit-04 (T1/T3/T5), audit-02 R4, audit-03 E7, audit-05 Q1/Q3 — gap-lists in `docs/drizzle-tx/audits/audit-0{2,3,4,5}-*.md`. **E7 scope decided HITL (this session):** the two contested renames are **KEPT** — option key stays `drizzle`, and `match`/`matchError` stay as-is. E7 here is **only** `DrizzleTx.isActive` → `isTransactionActive` (align with the manager) + a `manager` `@remarks` advanced-escape-hatch JSDoc.

**Depends on:** Plans A–D (landed). Verified current state: `create-drizzle-tx.ts` exposes `readonly isActive` (bound to `manager.isTransactionActive`); `adapters/drizzle.ts` throws `new PoolTimeoutError(undefined)` (R4 bug) on the pool-timeout branch and reads the pool structurally via `isPoolBacked($client)`; `package.json` `engines.node` is `>=22.13` in both packages; `vitest.config.ts` `coverage` has **no** `thresholds`; there is no `STABILITY.md`.

**Assumptions:**
- **R4:** the configured connection timeout lives on the pg Pool at `$client.options.connectionTimeoutMillis`. Read it structurally at `DrizzleAdapter` construction (same zero-`pg`-import discipline as `isPoolBacked`), store it, and pass it to `PoolTimeoutError`. `0`/absent (pg default = wait forever) → `undefined` (no finite timeout to report).
- **T1 unit:** a fake adapter that returns a *fresh* client object per `wrapWithTransaction` is required — `NoOpDrizzleAdapter` reuses **one** client for every boundary, so it cannot prove distinct-tx isolation. The fake is inline in the test.
- **Q1:** the true runtime floor is Node **20.4.0** (`Symbol.asyncDispose` / `await using`, per CLAUDE.md). Lower `engines.node` to `>=20.4.0` in both packages, and confirm the tsdown/tsc **build target** does not emit syntax newer than Node 20.4 supports (else the engines claim is a lie).
- **Coverage numbers (T5):** set thresholds at a floor *below* current coverage (a ratchet that catches regressions, not one that fails today). Read the current `pnpm test` coverage summary first and set thresholds a few points under it.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/test/unit/als-isolation.test.ts` | T1 concurrent ALS isolation (no DB) | **Create** |
| `packages/core/test/integration/concurrency.integration.test.ts` | T1 real-DB concurrent isolation | **Create** |
| `packages/core/test/integration/deep-nesting.integration.test.ts` | T3 depth-≥2 compositions | **Create** |
| `packages/core/src/adapters/drizzle.ts` | R4 fix | **Modify** — read + carry `connectionTimeoutMillis` |
| `packages/core/test/unit/drizzle.test.ts` | R4 test | **Modify** |
| `packages/core/src/create-drizzle-tx.ts` | E7 rename + JSDoc | **Modify** — `isActive`→`isTransactionActive`; `manager` `@remarks` |
| `packages/core/test/types/create-drizzle-tx.test-d.ts` | E7 type-test | **Modify** — `isTransactionActive` |
| `vitest.config.ts` | T5 coverage gate | **Modify** — add `coverage.thresholds` |
| `packages/core/package.json`, `packages/nestjs/package.json` | Q1 Node floor | **Modify** — `engines.node` |
| `STABILITY.md` | Q3 pre-1.0 policy | **Create** |

---

### Task 1: T1 — concurrent-request ALS isolation (the core property)

**Files:**
- Create: `packages/core/test/unit/als-isolation.test.ts`, `packages/core/test/integration/concurrency.integration.test.ts`

**Depends on:** Plans A–D only. **Riskiest-first & highest-value:** this property (concurrent requests never share a transaction context) is the library's entire reason to exist and is currently unasserted. These are **characterization tests — expect PASS**; a FAIL is a real ALS-bleed bug — stop and investigate, do not "fix" the test.

- [ ] **Step 1: Write the unit isolation test (no DB, distinct-client fake adapter)**

Create `packages/core/test/unit/als-isolation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TransactionAdapter } from '../../src/adapters/port.js';
import { ok } from '../../src/result.js';
import { TransactionManager } from '../../src/transaction-manager.js';

// A fake adapter that hands a FRESH client per boundary — required to prove isolation
// (NoOp reuses one client). Each wrapWithTransaction runs work with a unique {id}.
class DistinctClientAdapter implements TransactionAdapter<{ id: number }> {
  supportsIndependentTransactions = true;
  #n = 0;
  #base = { id: 0 };
  getBaseClient() { return this.#base; }
  async wrapWithTransaction<T>(_o: unknown, work: (tx: { id: number }) => Promise<T>) {
    return work({ id: ++this.#n });
  }
  async wrapWithNestedTransaction<T>(_p: { id: number }, work: (sp: { id: number }) => Promise<T>) {
    return work({ id: ++this.#n });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ALS isolation under concurrency', () => {
  it('concurrent withTransaction flows never share a tx client (no ALS bleed)', async () => {
    const m = new TransactionManager(new DistinctClientAdapter(), { logger: { warn() {} } });
    const seen: number[] = [];

    const oneFlow = () =>
      m.withTransaction(async () => {
        const first = (m.getTransactionClient() as { id: number }).id;
        await tick();                                   // yield — interleave with the other flows
        await tick();
        const afterYield = (m.getTransactionClient() as { id: number }).id;
        expect(afterYield).toBe(first);                 // this flow's client is STABLE across awaits
        seen.push(first);
        return ok(first);
      });

    const results = await Promise.all([oneFlow(), oneFlow(), oneFlow(), oneFlow(), oneFlow()]);
    // every flow committed, each saw its OWN client id, and all ids are pairwise distinct:
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(seen).size).toBe(5);
  });

  it('outside any transaction, getTransactionClient() is the base client and isActive is false', async () => {
    const m = new TransactionManager(new DistinctClientAdapter(), { logger: { warn() {} } });
    expect(m.isTransactionActive()).toBe(false);
    expect((m.getTransactionClient() as { id: number }).id).toBe(0); // base
    // a completed tx leaves no residue:
    await m.withTransaction(async () => ok(null));
    expect(m.isTransactionActive()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the unit test**

Run: `pnpm exec vitest run --project core-unit als-isolation.test.ts`
Expected: **PASS** — each concurrent flow's client id is stable across `await`s and all five are distinct; no bleed. *If it FAILS, an ALS leak exists — investigate `TransactionContext`/`#runInBoundary`, do not weaken the test.*

- [ ] **Step 3: Write the real-DB concurrency test**

Create `packages/core/test/integration/concurrency.integration.test.ts` (mirror `propagation.integration.test.ts`'s harness: `createTestDb()`, `TransactionManager`+`DrizzleAdapter`, `createTransactionalClient` `db` proxy, `beforeEach` `TRUNCATE users, accounts`). **Import only what's used** — `ok` from result, `users` from schema (not `accounts` — the truncate is a raw string, so an `accounts` import would be an unused-import lint hit). Prove real isolation + correct auto-join under concurrency:

```ts
it('N concurrent transactions are isolated and each proxy auto-joins its own tx', async () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const results = await Promise.all(
    names.map((name) =>
      manager.withTransaction(async () => {
        const [u] = await db.insert(users).values({ name }).returning(); // proxy auto-joins THIS tx
        // interleave, then confirm this tx sees ONLY its own uncommitted row:
        const mine = await db.select().from(users);
        expect(mine.map((r) => r.name)).toEqual([name]); // isolation: no other tx's row visible
        return ok(u.id);
      }),
    ),
  );
  expect(results.every((r) => r.ok)).toBe(true);
  // after all commit, all five rows are present exactly once:
  const all = await db.select().from(users);
  expect(all.map((r) => r.name).sort()).toEqual(names);
});
```

- [ ] **Step 4: Run the integration test**

Run: `pnpm exec vitest run --project core-integration concurrency.integration.test.ts` (Docker)
Expected: **PASS** — each concurrent tx sees only its own uncommitted row (isolation), the proxy auto-joins the correct tx per flow, and all five commit. *A FAIL here is a real isolation/auto-join bug.*

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/unit/als-isolation.test.ts packages/core/test/integration/concurrency.integration.test.ts
git commit -m "test(core): T1 concurrent-request ALS isolation — unit (no-bleed) + real-DB isolation/auto-join"
```

---

### Task 2: T3 — deep-nesting propagation compositions (depth ≥2)

**Files:**
- Create: `packages/core/test/integration/deep-nesting.integration.test.ts`

**Depends on:** Task 1 harness pattern. Characterization tests for depth-≥2 compositions the existing suite only covers at depth 1. **Expect PASS.**

- [ ] **Step 1: Write the deep-nesting compositions**

Create `packages/core/test/integration/deep-nesting.integration.test.ts` (same harness). **Import only what's used**: `err, ok` from result, `Propagation`, `users` from schema (not `accounts`). Cover the compositions that only bite at depth ≥2:

```ts
it('REQUIRED → NESTED → NESTED: inner savepoint rollback keeps outer work', async () => {
  const r = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'root' });
    const inner = await manager.withTransaction(Propagation.Nested, async () => {
      await db.insert(users).values({ name: 'sp1' });
      const innermost = await manager.withTransaction(Propagation.Nested, async () => {
        await db.insert(users).values({ name: 'sp2' });
        return err({ kind: 'RollbackInnermost' } as const); // rolls back sp2 only
      });
      expect(innermost.ok).toBe(false);
      return ok('sp1-kept');                                // sp1 + root commit
    });
    expect(inner).toEqual({ ok: true, value: 'sp1-kept' });
    return ok(null);
  });
  expect(r.ok).toBe(true);
  const names = (await db.select().from(users)).map((u) => u.name).sort();
  expect(names).toEqual(['root', 'sp1']);                  // sp2 rolled back; root + sp1 survive
});

it('REQUIRED → NESTED → REQUIRES_NEW: independent inner commits even when the outer rolls back', async () => {
  const r = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'outer' });
    const indep = await manager.withTransaction(Propagation.Nested, async () =>
      manager.withTransaction(Propagation.RequiresNew, async () => {
        await db.insert(users).values({ name: 'independent' }); // own connection/tx
        return ok('committed-independently');
      }),
    );
    expect(indep.ok).toBe(true);
    return err({ kind: 'RollbackOuter' } as const);        // outer (+ its savepoint) roll back
  });
  expect(r.ok).toBe(false);
  // the REQUIRES_NEW row persisted on its own connection; 'outer' rolled back:
  const names = (await db.select().from(users)).map((u) => u.name).sort();
  expect(names).toEqual(['independent']);
}, 10000);
```

(Pool `max` must exceed the deepest concurrent connection count for REQUIRES_NEW — `createTestDb()`'s default pool covers depth 2; if a test deadlocks, that's the ADR-0002 pool-sizing caveat, not a bug.)

- [ ] **Step 2: Run the test**

Run: `pnpm exec vitest run --project core-integration deep-nesting.integration.test.ts` (Docker)
Expected: **PASS** — savepoint-of-savepoint rolls back only the innermost; a REQUIRES_NEW nested inside a NESTED commits independently of an outer rollback. *A FAIL is a real propagation-composition bug.*

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/integration/deep-nesting.integration.test.ts
git commit -m "test(core): T3 deep-nesting propagation compositions (depth >=2) end-to-end"
```

---

### Task 3: R4 — `PoolConnectionTimeout` carries the configured timeout

**Files:**
- Modify: `packages/core/src/adapters/drizzle.ts`
- Test: `packages/core/test/unit/drizzle.test.ts`

**Depends on:** Plans A–D only. A genuine bug fix (TDD): `throw new PoolTimeoutError(undefined)` discards the real timeout, so `PoolConnectionTimeout.timeoutMs` is *always* `undefined`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/unit/drizzle.test.ts` a test that a pool-connect timeout surfaces the configured `connectionTimeoutMillis`. Use a fake drizzle whose `$client` carries the pool-timeout structural markers + a `transaction()` that rejects with the pg timeout message:

```ts
import { DrizzleAdapter, PoolTimeoutError } from '../../src/adapters/drizzle.js';

it('a pool-connect timeout carries the configured connectionTimeoutMillis (R4)', async () => {
  const fakeDb = {
    $client: { totalCount: 1, idleCount: 0, options: { connectionTimeoutMillis: 3000 } },
    transaction: async () => { throw new Error('timeout exceeded when trying to connect'); },
  } as unknown as import('../../src/adapters/drizzle.js').DrizzleTxCapable;

  const adapter = new DrizzleAdapter({ db: fakeDb });
  // (uses the imported PoolTimeoutError so the import isn't dead — assert the type AND the value)
  await expect(adapter.wrapWithTransaction(undefined, async () => 'x')).rejects.toBeInstanceOf(PoolTimeoutError);
  await expect(adapter.wrapWithTransaction(undefined, async () => 'x')).rejects.toMatchObject({
    timeoutMs: 3000, // carries the CONFIGURED timeout, not the hard-coded undefined
  });
});

it('reports undefined when no finite connectionTimeoutMillis is configured', async () => {
  const fakeDb = {
    $client: { totalCount: 1, idleCount: 0, options: {} }, // pg default: wait forever
    transaction: async () => { throw new Error('timeout exceeded when trying to connect'); },
  } as unknown as import('../../src/adapters/drizzle.js').DrizzleTxCapable;
  await expect(new DrizzleAdapter({ db: fakeDb }).wrapWithTransaction(undefined, async () => 'x'))
    .rejects.toMatchObject({ timeoutMs: undefined });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit drizzle.test.ts`
Expected: FAIL — the first test gets `timeoutMs: undefined` (the hard-coded value), not `3000`.

- [ ] **Step 3: Fix the adapter**

In `packages/core/src/adapters/drizzle.ts`, read the pool's timeout structurally at construction (no `pg` import — mirror `isPoolBacked`) and carry it:

```ts
/** The configured pg pool connect timeout, read structurally (no pg import). `0`/absent means
 *  "wait forever" (pg default) → no finite timeout to report. */
function poolConnectTimeoutMs(client: unknown): number | undefined {
  const ms = (client as { options?: { connectionTimeoutMillis?: unknown } })?.options?.connectionTimeoutMillis;
  return typeof ms === 'number' && ms > 0 ? ms : undefined;
}

// in the class: add a field
readonly #connectTimeoutMs: number | undefined;
// in the constructor:
this.#connectTimeoutMs = poolConnectTimeoutMs(config.db.$client);

// in wrapWithTransaction's catch:
if (e instanceof Error && /timeout exceeded when trying to connect/i.test(e.message)) {
  throw new PoolTimeoutError(this.#connectTimeoutMs);   // was: new PoolTimeoutError(undefined)
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm exec vitest run --project core-unit drizzle.test.ts`
Expected: PASS — configured `3000` is carried; absent → `undefined`. Then confirm the classification end-to-end still maps it (`classifyRollback`→`poolConnectionTimeout(timeoutMs)`):
Run: `pnpm test:unit`
Expected: PASS — no regression (the existing REQUIRES_NEW pool-exhaustion integration test now gets a populated `timeoutMs`, but it asserts on `kind`, not the value).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/drizzle.ts packages/core/test/unit/drizzle.test.ts
git commit -m "fix(core): PoolConnectionTimeout carries the configured connectionTimeoutMillis (R4)"
```

---

### Task 4: E7 — `isActive` → `isTransactionActive` + `manager` JSDoc

**Files:**
- Modify: `packages/core/src/create-drizzle-tx.ts`, `packages/core/test/types/create-drizzle-tx.test-d.ts`, `packages/core/test/unit/create-drizzle-tx.test.ts`, `packages/core/README.md`

**Depends on:** Plans A–D only. The two agreed E7 cleanups (contested renames were KEPT — see Source of truth). Pre-1.0 breaking rename of the factory field.

⚠️ **The rename is a RUNTIME break, not just a type break** — `packages/core/test/unit/create-drizzle-tx.test.ts` calls `tx.isActive` / destructures `{ isActive }` in ~4 places (lines ~31/40/58/59). Vitest transpiles without typechecking, so these are **not** caught by `pnpm typecheck` — they fail (as `tx.isActive is not a function`) only at the final `pnpm test`. This file MUST be updated in this task.

- [ ] **Step 1: Rename the factory field + label `manager`**

In `packages/core/src/create-drizzle-tx.ts`:
- Rename the `DrizzleTx` interface member `isActive` → `isTransactionActive` (keep the indexed type `TransactionManager<TClient>['isTransactionActive']`) so the factory name matches the manager method — one concept, one name.
- Rename the returned property `isActive: manager.isTransactionActive.bind(manager)` → `isTransactionActive: manager.isTransactionActive.bind(manager)`.
- Add an `@remarks` to the `manager` member JSDoc marking it the **advanced escape hatch**: "The full `TransactionManager` — advanced/adapter-author use (e.g. wrapping in a framework adapter). App code uses `db` + `withTransaction`/`begin`, not this."

- [ ] **Step 2: Update BOTH the type-test and the runtime unit test**

- In `packages/core/test/types/create-drizzle-tx.test-d.ts`, change `tx.isActive()` → `tx.isTransactionActive()` (the `const _active: boolean = tx.isActive();` assertion).
- In `packages/core/test/unit/create-drizzle-tx.test.ts`, update all `isActive` references (~lines 31/40/58/59): `typeof tx.isActive` → `typeof tx.isTransactionActive`, `tx.isActive()` → `tx.isTransactionActive()`, and the destructure `const { withTransaction, isActive } = …` / `isActive()` → `isTransactionActive`.

- [ ] **Step 3: Verify no other consumers (incl. destructured, no-dot usages)**

Run: `grep -rn "\bisActive\b" packages/ docs/ --include=*.ts --include=*.md`
Expected: no remaining references to the factory `isActive` — **broad `\b` word-boundary (NOT `\.isActive`)** so destructured `{ isActive }` usages are caught too. Update any hit. Known consumers to fix: the two test files above **and** the user-facing README examples (`packages/core/README.md` ~lines 17/96 destructure `{ …, isActive, … }`) plus `docs/drizzle-tx/next-trpc-adapter-design.md`. Leave `CHANGELOG.md` (historical release notes) untouched.
Run: `pnpm build && pnpm typecheck`
Expected: PASS — the renamed field + type-test compile (the runtime unit test compiles regardless; its correctness is proven at the final `pnpm test`).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/create-drizzle-tx.ts packages/core/test/types/create-drizzle-tx.test-d.ts \
        packages/core/test/unit/create-drizzle-tx.test.ts packages/core/README.md docs/drizzle-tx/next-trpc-adapter-design.md
git commit -m "refactor(core): rename DrizzleTx.isActive -> isTransactionActive; label manager as advanced (E7)"
```

---

### Task 5: T5 — coverage-threshold CI gate

**Files:**
- Modify: `vitest.config.ts`

**Depends on:** Tasks 1–3 (they add coverage). Turn the informational coverage report into a **ratchet** that fails CI on regression.

- [ ] **Step 1: Read current coverage**

Run: `pnpm test -- --coverage` (or `pnpm vitest run --coverage`; Docker for the integration projects)
Expected: a coverage summary table. Record the current lines/functions/branches/statements %.

- [ ] **Step 2: Add thresholds a few points below current**

In `vitest.config.ts`, add to the `coverage` block a `thresholds` set a few points under the measured numbers (a regression catcher, not a today-failer):

```ts
coverage: {
  provider: 'v8',
  include: ['packages/*/src/**'],
  reporter: ['text', 'html'],
  reportsDirectory: './coverage',
  thresholds: {
    lines: 90, functions: 90, branches: 85, statements: 90, // set from Step 1 minus a small margin
  },
},
```

(Pick the actual numbers from Step 1 — e.g. if lines are 97%, floor at 92–95. Do NOT set 100 — the NoOp/fault-injecting `/testing` surfaces and defensive branches keep it under 100 by design.)

- [ ] **Step 3: Verify the gate passes at HEAD and would fail on regression**

Run: `pnpm test -- --coverage`
Expected: PASS — current coverage clears the thresholds. (Optional sanity: temporarily bump a threshold above current to confirm it fails, then revert.)

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts
git commit -m "test: add coverage.thresholds CI gate (ratchet against regression) (T5)"
```

---

### Task 6: Q1 (Node floor) + Q3 (STABILITY.md)

**Files:**
- Modify: `packages/core/package.json`, `packages/nestjs/package.json`
- Create: `STABILITY.md`

**Depends on:** Plans A–D only. Packaging/policy metadata.

- [ ] **Step 1: Lower the Node floor to the true `await using` floor**

In both `packages/core/package.json` and `packages/nestjs/package.json`, change `"engines": { "node": ">=22.13" }` → `">=20.4.0"` (the `Symbol.asyncDispose`/`await using` runtime floor; CLAUDE.md). **Confirm the build target agrees:** check the tsdown config (core) / `tsconfig` `target` (nestjs) do not emit syntax above Node 20.4's support; if a `target`/`engines` mismatch exists, align the build target to the new floor.

- [ ] **Step 2: Verify the toolchain accepts the floor**

Run: `pnpm build && pnpm typecheck`
Expected: PASS — the `ESNext.Disposable` lib + `await using` still typecheck (lib is independent of the engines field). 
Note: a true Node-20 runtime smoke test belongs in **CI** (add/confirm a Node 20.4 job in the matrix if one isn't present) — the dev machine may run newer; state this in the commit so the CI matrix is the real gate.

- [ ] **Step 3: Write STABILITY.md (Q3)**

Create `STABILITY.md` at the repo root: a short **pre-1.0 stability policy** — semver-zero caveat (minors may break), what's covered vs experimental (`@drizzle-tx/core` public tiers A/B are the committed surface; `/testing` is stable-but-test-only; `@drizzle-tx/nestjs` tracks core), the breaking-change process (changeset + CHANGELOG), and the support floor (Node ≥ 20.4). Keep it to ~1 screen; link it from both package READMEs' header.

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json packages/nestjs/package.json STABILITY.md
git commit -m "chore: lower Node floor to >=20.4.0 (Q1) + add pre-1.0 STABILITY.md (Q3)"
```

---

### Task 7: Final gate — the core-quality bar is met

**Files:** none (verification only).

- [ ] **Step 1: Full build + typecheck + test(+coverage) + publish check**

Run: `pnpm build`
Expected: PASS — core (tsdown dual ESM+CJS), nestjs (tsc CJS).
Run: `pnpm typecheck`
Expected: PASS — all `*.test-d.ts` incl. the E7 `isTransactionActive` change.
Run: `pnpm test -- --coverage` (Docker)
Expected: PASS — all projects green (T1 unit + T1/T3 integration + R4 + existing suite); coverage clears the new thresholds.
Run: `pnpm -r run check:publish`
Expected: PASS — `attw` + `publint --strict`; the renamed `isTransactionActive` and the new engines floor resolve.

- [ ] **Step 2: Close out the core-quality program**

This is the **last** core-quality plan (A–E). With it merged, the map #19 quality bar is fully *implemented*, not just specified. Note in the PR that the flagship Next.js/tRPC adapters (#12–#14) are now unblocked: the base is hardened (structured errors, fault-injection testing, the branded adapter-author surface, scope leak-backstop, and now asserted concurrency isolation).

---

## Downstream (the flagship — NOT in this plan)

- **Flagship framework adapters** (#12 tRPC / #13 Next.js / #14 example app) — the next effort, now fully unblocked. They build on the callback primitive (ADR-0014 E1) and the exported `WithTransaction<TClient>` (#32/Plan C).
- **Deferred (not core-quality):** `scope.outcome` (ADR-0014 E6), G3 multi-driver capability descriptor, G6 SUPPORTS/NOT_SUPPORTED, the hooks/OTel/retry PRD (attaches at the ADR-0013 lifecycle seam).
