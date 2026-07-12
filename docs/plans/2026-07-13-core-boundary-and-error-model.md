# Core Boundary + Structured Error Model — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use the repo's available execution skill when one exists (for example, `executing-plans` or `tdd`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single opaque `TransactionAborted{cause}` failure with the ADR-0012 structured error model (SQLSTATE-bearing triad + named `SerializationFailure`/`DeadlockDetected`/`ConnectionLost` variants), preserve a swallowed domain error on a rollback double-fault (`lostDomainError`), then de-duplicate the two boundary shells into one `#runInBoundary` (G5) with the immutable-store invariant documented (ADR-0013).

**Architecture:** Classification stays **structural and in core** (`rollback-boundary.ts`) — it reads `.code`/`.severity`/`.syscall`/`.message` off the caught value with **zero `pg` import**, exactly as `isPoolTimeoutError` already does. The manager stashes the in-flight domain error in a **boundary-local closure variable** (never ALS state) so the boundary can recover it when a failing ROLLBACK shadows it. G5 is sequenced **last** here (ADR-0013 §4: after the error model reshapes the boundary, so it isn't extracted twice).

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly` — no constructor parameter properties), Vitest 4, tsdown dual ESM+CJS build, real-Postgres via Testcontainers (integration only).

**Source of truth:** [ADR-0012](../adr/0012-structured-transaction-failure-error-model.md) (error model, R1, R2, §3 classification table), [ADR-0013](../adr/0013-transaction-lifecycle-observation-seam.md) §3 (immutable-store invariant) + §4 (G5). This plan does **not** design any lifecycle event API (deferred to the hooks/OTel PRD per ADR-0013).

**Assumptions:**
- `classifyRollback` gains a second parameter `inFlight?: { error: E }` (ADR-0012 §2). Its two existing callers (`#newTransaction`, `#nested`) and its unit test (`rollback-boundary.test.ts`) update in lockstep. Inferred call shape from ADR-0012 §2's code block.
- `transactionAborted`'s constructor signature changes from `(cause: unknown)` to `(fields: TxFailureFields)` (ADR-0012 §1). **Two** callers update to the new shape: the production `src/transaction-scope.ts:60` and the test `transaction-scope.test.ts`. This is a pre-1.0 breaking change (sanctioned by the map). ⚠️ The scope-source break is **not** compile-flagged by `pnpm test:unit` (vitest/esbuild transpiles without typechecking) — it surfaces as a runtime test failure (`transaction-scope.test.ts:78` asserts `String(error.cause)` contains "closed before it started", which spreading a bare `Error` no longer satisfies) and is only type-flagged by `pnpm typecheck` in Task 6. Fix it in Task 3.
- The Task 3 inline fake adapter calls `work({})` (not `work()`): the port types `work: (tx: TClient) => Promise<T>`, so a zero-arg call is TS2554 under `pnpm typecheck`.
- Structural SQLSTATE detection recognises a pg `DatabaseError` by a **5-char string `.code` accompanied by a string `.severity`** (ADR-0012 §3 step 2), not `instanceof` — consistent with the repo's cross-`pg`-instance discipline (CLAUDE.md).
- The R2 unit test uses a small **inline fake adapter** whose `wrapWithTransaction` throws a non-`RollbackSignal` error (simulating drizzle's ROLLBACK shadowing) — the full `FaultInjectingDrizzleAdapter` (#28) is a *later* plan; Plan A needs only a hand-rolled throw.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/errors.ts` | `DrizzleTxError` union + constructors | **Modify** — add `TxFailureFields`, 3 named tx-body variants, widen `TransactionAborted`; change `transactionAborted` signature; add `serializationFailure`/`deadlockDetected`/`connectionLost` |
| `packages/core/src/rollback-boundary.ts` | Structural classification | **Modify** — `classifyRollback(e, inFlight?)`; add `classifyCaught` (socket-first → SQLSTATE table → residual) + `txFailureFieldsOf` helper |
| `packages/core/src/transaction-scope.ts` | `begin()` scope gate | **Modify** — its `transactionAborted(new Error(...))` call (line 60) breaks on the signature change → pass `TxFailureFields` |
| `packages/core/src/transaction-manager.ts` | Boundary shells | **Modify** — stash `inFlight` in `#newTransaction`/`#nested`; then extract both into one `#runInBoundary` (G5); JSDoc R1 + immutable-store invariant |
| `packages/core/test/unit/errors.test.ts` | Constructor unit tests | **Modify** — new constructors |
| `packages/core/test/types/errors.test-d.ts` | Exhaustiveness fixtures | **Modify** — add the 3 new kinds to both switch + `matchError` maps |
| `packages/core/test/unit/rollback-boundary.test.ts` | Classification unit tests | **Modify** — the classification matrix + `lostDomainError` |
| `packages/core/test/unit/transaction-manager.test.ts` | Manager R2 + G5 behavior | **Modify** — `lostDomainError` stash via inline fake adapter |
| `packages/core/test/integration/propagation.integration.test.ts` | R1 COMMIT-fails real-DB | **Modify** — deferred-constraint COMMIT-failure case |

No file exceeds ~300 lines after changes. `errors.ts` (~38→~75 LOC) and `rollback-boundary.ts` (~40→~95 LOC) stay single-responsibility.

---

### Task 1: Structured error variants + constructors (`errors.ts`)

**Files:**
- Modify: `packages/core/src/errors.ts`
- Test: `packages/core/test/unit/errors.test.ts`, `packages/core/test/types/errors.test-d.ts`

**Depends on:** nothing. **Riskiest-first rationale:** this is the breaking type change every later task and fixture keys off; land and compile-verify it before any logic.

- [ ] **Step 1: Write the failing constructor tests**

In `packages/core/test/unit/errors.test.ts`, add:

```ts
import { connectionLost, deadlockDetected, serializationFailure, transactionAborted } from '../../src/errors.js';

it('serializationFailure carries the triad + kind', () => {
  const cause = new Error('40001');
  expect(serializationFailure({ message: 'conflict', sqlState: '40001', cause })).toEqual({
    kind: 'SerializationFailure',
    message: 'conflict',
    sqlState: '40001',
    cause,
  });
});

it('deadlockDetected carries kind DeadlockDetected', () => {
  expect(deadlockDetected({ message: 'deadlock', sqlState: '40P01', cause: undefined }).kind).toBe('DeadlockDetected');
});

it('connectionLost allows undefined sqlState (socket loss)', () => {
  const e = connectionLost({ message: 'Connection terminated unexpectedly', sqlState: undefined, cause: new Error() });
  expect(e).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
});

it('transactionAborted now takes TxFailureFields and can carry lostDomainError', () => {
  const domain = { kind: 'SoldOut' };
  const e = transactionAborted({ message: 'rollback failed', sqlState: undefined, cause: new Error('x'), lostDomainError: domain });
  expect(e).toMatchObject({ kind: 'TransactionAborted', message: 'rollback failed', lostDomainError: domain });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit errors.test.ts`
Expected: FAIL — `serializationFailure`/`deadlockDetected`/`connectionLost` are not exported; `transactionAborted` rejects the object argument (still typed `(cause: unknown)`).

- [ ] **Step 3: Implement the new union + constructors**

Rewrite `packages/core/src/errors.ts`'s union + constructors per ADR-0012 §1:

```ts
/** Structured fields carried by every transaction-body failure (ADR-0012 §1). */
export interface TxFailureFields {
  readonly message: string;
  readonly sqlState: string | undefined;
  readonly cause: unknown;
  /** R2: the swallowed domain error when a rollback double-fault ate it. Distinct from `cause`. */
  readonly lostDomainError?: unknown;
}

export type DrizzleTxError =
  // assembly / pool — no structured triad:
  | { readonly kind: 'PoolConnectionTimeout'; readonly timeoutMs: number | undefined }
  | { readonly kind: 'HostNotInitialized'; readonly connectionName: string | undefined }
  | { readonly kind: 'NotPoolBacked' }
  // transaction-body failures — all carry TxFailureFields:
  | ({ readonly kind: 'SerializationFailure' } & TxFailureFields)
  | ({ readonly kind: 'DeadlockDetected' } & TxFailureFields)
  | ({ readonly kind: 'ConnectionLost' } & TxFailureFields)
  | ({ readonly kind: 'TransactionAborted' } & TxFailureFields);

export const serializationFailure = (f: TxFailureFields): DrizzleTxError => ({ kind: 'SerializationFailure', ...f });
export const deadlockDetected = (f: TxFailureFields): DrizzleTxError => ({ kind: 'DeadlockDetected', ...f });
export const connectionLost = (f: TxFailureFields): DrizzleTxError => ({ kind: 'ConnectionLost', ...f });
export const transactionAborted = (f: TxFailureFields): DrizzleTxError => ({ kind: 'TransactionAborted', ...f });
```

Keep `poolConnectionTimeout`, `hostNotInitialized`, `notPoolBacked`, `DrizzleTxErrorKind`, `DrizzleTxErrorHandlers`, `matchError` unchanged.

- [ ] **Step 4: Update the exhaustiveness fixtures (they MUST break, then compile)**

In `packages/core/test/types/errors.test-d.ts`, add the three new kinds to the `switch` and to **both** `matchError` maps (`matchOk` and the `@ts-expect-error` `matchBad` — leave `matchBad` still missing exactly one kind so the negative test still holds). Example additions to `describeError`:

```ts
case 'SerializationFailure': return `serialization ${e.sqlState}`;
case 'DeadlockDetected': return `deadlock ${e.sqlState}`;
case 'ConnectionLost': return `connection lost: ${e.message}`;
```

- [ ] **Step 5: Run unit + type tests to verify pass**

Run: `pnpm exec vitest run --project core-unit errors.test.ts`
Expected: PASS for all four new constructor tests.
Run: `pnpm --filter @drizzle-tx/core exec tsc -p tsconfig.test-d.json --noEmit`
Expected: PASS — `describeError` compiles exhaustively; `matchBad`'s `@ts-expect-error` is still consumed (map still omits one kind).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/errors.ts packages/core/test/unit/errors.test.ts packages/core/test/types/errors.test-d.ts
git commit -m "feat(core): structured DrizzleTxError variants + TxFailureFields (ADR-0012 §1)"
```

---

### Task 2: Structural classification (`rollback-boundary.ts`)

**Files:**
- Modify: `packages/core/src/rollback-boundary.ts`
- Test: `packages/core/test/unit/rollback-boundary.test.ts`

**Depends on Task 1** (the new variants). This is the fragile logic — socket-loss must be checked **before** SQLSTATE mapping (ADR-0012 §3), because a libuv `EPIPE` looks like a 5-char SQLSTATE.

- [ ] **Step 1: Write the failing classification tests**

Add to `packages/core/test/unit/rollback-boundary.test.ts` a table covering every §3 branch. Use plain objects shaped like the real caught values — no `pg` import:

```ts
import { classifyRollback, RollbackSignal } from '../../src/rollback-boundary.js';

// helper: a fake pg DatabaseError — 5-char .code + string .severity (structural marker)
const dbErr = (code: string, message = 'db error') => Object.assign(new Error(message), { code, severity: 'ERROR', routine: 'exec_simple_query' });
// helper: a libuv socket error
const sockErr = (code: string) => Object.assign(new Error(code), { code, syscall: 'read' });

it('40001 → SerializationFailure with sqlState', () => {
  const r = classifyRollback(dbErr('40001', 'could not serialize'));
  expect(r).toMatchObject({ ok: false, error: { kind: 'SerializationFailure', sqlState: '40001', message: 'could not serialize' } });
});

it('40P01 → DeadlockDetected', () => {
  expect((classifyRollback(dbErr('40P01')) as { error: { kind: string } }).error.kind).toBe('DeadlockDetected');
});

it.each(['08000', '08006', '08P01', '57P01', '57P03'])('%s → ConnectionLost with sqlState', (code) => {
  expect((classifyRollback(dbErr(code)) as { error: { kind: string; sqlState: string } }).error).toMatchObject({ kind: 'ConnectionLost', sqlState: code });
});

it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT'])('libuv %s → ConnectionLost with UNDEFINED sqlState (socket checked first)', (code) => {
  expect((classifyRollback(sockErr(code)) as { error: { kind: string; sqlState: undefined } }).error).toMatchObject({ kind: 'ConnectionLost', sqlState: undefined });
});

it('code-less "Connection terminated unexpectedly" → ConnectionLost, undefined sqlState', () => {
  expect((classifyRollback(new Error('Connection terminated unexpectedly')) as { error: { kind: string } }).error.kind).toBe('ConnectionLost');
});

it('57014 query_canceled → TransactionAborted but KEEPS sqlState', () => {
  expect((classifyRollback(dbErr('57014')) as { error: { kind: string; sqlState: string } }).error).toMatchObject({ kind: 'TransactionAborted', sqlState: '57014' });
});

it('plain user throw → TransactionAborted, undefined sqlState, message preserved', () => {
  expect((classifyRollback(new Error('boom')) as { error: { kind: string; sqlState: undefined; message: string } }).error).toMatchObject({ kind: 'TransactionAborted', sqlState: undefined, message: 'boom' });
});

it('non-Error throw (string) → TransactionAborted with a default message', () => {
  const r = classifyRollback('weird') as { error: { kind: string; message: string; cause: unknown } };
  expect(r.error.kind).toBe('TransactionAborted');
  expect(typeof r.error.message).toBe('string');
  expect(r.error.cause).toBe('weird');
});

it('RollbackSignal → err(payload) unchanged (domain error faithful)', () => {
  expect(classifyRollback(new RollbackSignal({ kind: 'SoldOut' }))).toEqual({ ok: false, error: { kind: 'SoldOut' } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit rollback-boundary.test.ts`
Expected: FAIL — everything non-`RollbackSignal`/non-pool currently returns the old `transactionAborted(cause)` shape (no `sqlState`/`kind` discrimination).

- [ ] **Step 3: Implement structural classification**

Rewrite `classifyRollback` + add helpers in `packages/core/src/rollback-boundary.ts`. Keep `RollbackSignal`, `PoolTimeoutLike`, `isPoolTimeoutError`, `toThrowable`. Add:

```ts
const SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED']);
const CONN_LOST_SQLSTATE = new Set(['08000','08001','08003','08004','08006','08007','08P01','57P01','57P02','57P03','57P04','57P05']);

const messageOf = (e: unknown): string =>
  typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
    ? (e as { message: string }).message
    : String(e);

/** A pg DatabaseError is recognised structurally: a 5-char string `.code` with a string `.severity`. */
const sqlStateOf = (e: unknown): string | undefined => {
  if (typeof e !== 'object' || e === null) return undefined;
  const { code, severity } = e as { code?: unknown; severity?: unknown };
  return typeof code === 'string' && code.length === 5 && typeof severity === 'string' ? code : undefined;
};

/** Socket / code-less teardown — checked BEFORE SQLSTATE so a libuv EPIPE is never read as a SQLSTATE. */
const isSocketLoss = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false;
  const { syscall, code, severity, message } = e as { syscall?: unknown; code?: unknown; severity?: unknown; message?: unknown };
  if (typeof syscall === 'string') return true;
  if (typeof code === 'string' && SOCKET_CODES.has(code) && typeof severity !== 'string') return true;
  return typeof message === 'string' && message.includes('Connection terminated') && sqlStateOf(e) === undefined;
};

/** Pure. Classify a non-RollbackSignal caught value into a structured DrizzleTxError (ADR-0012 §3). */
export function classifyCaught(e: unknown, lostDomainError?: unknown): DrizzleTxError {
  const base = { message: messageOf(e), cause: e, ...(lostDomainError !== undefined ? { lostDomainError } : {}) };
  if (isSocketLoss(e)) return connectionLost({ ...base, sqlState: undefined });
  const sqlState = sqlStateOf(e);
  if (sqlState === '40001') return serializationFailure({ ...base, sqlState });
  if (sqlState === '40P01') return deadlockDetected({ ...base, sqlState });
  if (sqlState !== undefined && CONN_LOST_SQLSTATE.has(sqlState)) return connectionLost({ ...base, sqlState });
  return transactionAborted({ ...base, sqlState });
}

/** Classify a throw caught at the transaction boundary. `inFlight` (ADR-0012 §2) is the domain
 *  error recorded before the rollback signal was thrown — attached as `lostDomainError` only when
 *  the caught value is NOT the RollbackSignal (i.e. a failing ROLLBACK shadowed it). */
export function classifyRollback<E>(e: unknown, inFlight?: { error: E }): Result<never, E | DrizzleTxError> {
  if (e instanceof RollbackSignal) return err(e.payload as E);
  if (isPoolTimeoutError(e)) return err(poolConnectionTimeout(e.timeoutMs));
  return err(classifyCaught(e, inFlight?.error));
}
```

Update the imports at the top to add `connectionLost, deadlockDetected, serializationFailure` (drop the now-unused direct `transactionAborted` import only if unused — it is still used by `classifyCaught`).

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm exec vitest run --project core-unit rollback-boundary.test.ts`
Expected: PASS for the full classification matrix (serialization / deadlock / SQLSTATE conn-loss / socket conn-loss / code-less teardown / residual-with-sqlState / plain throw / non-Error / RollbackSignal).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/rollback-boundary.ts packages/core/test/unit/rollback-boundary.test.ts
git commit -m "feat(core): structural SQLSTATE classification at the rollback boundary (ADR-0012 §3)"
```

---

### Task 3: R2 — manager stashes the in-flight domain error (`transaction-manager.ts`)

**Files:**
- Modify: `packages/core/src/transaction-manager.ts`
- Modify: `packages/core/src/transaction-scope.ts` (fix the broken `transactionAborted` call — Assumptions)
- Test: `packages/core/test/unit/transaction-manager.test.ts`

**Depends on Task 2** (`classifyRollback`'s 2-arg form). Implements ADR-0012 §2 in **both** `#newTransaction` and `#nested` (Task 5 then merges them). The stash is a boundary-local closure variable — **not** ALS state (ADR-0006/0013 immutable store).

- [ ] **Step 1: Write the failing R2 test**

Add to `packages/core/test/unit/transaction-manager.test.ts` an inline fake adapter whose `wrapWithTransaction` runs `work` then throws a non-`RollbackSignal` error (simulating drizzle's ROLLBACK shadowing the domain error):

```ts
import { TransactionManager } from '../../src/transaction-manager.js';
import type { TransactionAdapter } from '../../src/adapters/port.js';
import { err, ok } from '../../src/result.js';

// Adapter that lets work run, then throws a rollback-time failure that SHADOWS the RollbackSignal.
class RollbackShadowAdapter implements TransactionAdapter<{}> {
  supportsIndependentTransactions = true;
  getBaseClient() { return {}; }
  async wrapWithTransaction<T>(_o: unknown, work: (tx: {}) => Promise<T>): Promise<T> {
    await work({}).catch(() => {});               // work throws RollbackSignal(domainErr); swallow it
    throw Object.assign(new Error('ROLLBACK failed'), { code: '08006', severity: 'ERROR' });
  }
  async wrapWithNestedTransaction<T>(_p: {}, work: (sp: {}) => Promise<T>): Promise<T> {
    await work({}).catch(() => {});
    throw Object.assign(new Error('ROLLBACK TO SAVEPOINT failed'), { code: '08006', severity: 'ERROR' });
  }
}

it('rollback double-fault: infra error wins, domain err preserved in lostDomainError', async () => {
  const m = new TransactionManager<{}>(new RollbackShadowAdapter(), { logger: { warn() {} } });
  const domain = { kind: 'SoldOut' } as const;
  const r = await m.withTransaction(async () => err(domain));
  expect(r.ok).toBe(false);
  if (r.ok) return;
  // infra failure wins the channel (classified from the 08006 shadow), domain E preserved:
  expect(r.error).toMatchObject({ kind: 'ConnectionLost', lostDomainError: domain });
});

it('normal path: ROLLBACK succeeds → domain err returned faithfully, no lostDomainError', async () => {
  // NoOp-style adapter that re-throws whatever work threw (RollbackSignal survives)
  const m = new TransactionManager<{}>(new (class implements TransactionAdapter<{}> {
    supportsIndependentTransactions = true; getBaseClient() { return {}; }
    async wrapWithTransaction<T>(_o: unknown, work: (tx: {}) => Promise<T>) { return work({} as {}); }
    async wrapWithNestedTransaction<T>(_p: {}, work: (sp: {}) => Promise<T>) { return work({} as {}); }
  })(), { logger: { warn() {} } });
  const r = await m.withTransaction(async () => err({ kind: 'SoldOut' } as const));
  expect(r).toEqual({ ok: false, error: { kind: 'SoldOut' } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-unit transaction-manager.test.ts`
Expected: FAIL — the first test currently gets `{ kind: 'ConnectionLost' }` **without** `lostDomainError` (the stash isn't wired), so the `lostDomainError: domain` match fails.

- [ ] **Step 3: Wire the stash in both shells**

In `#newTransaction` and `#nested`, record the in-flight error before `toThrowable` throws, and pass it to `classifyRollback` (ADR-0012 §2):

```ts
async #newTransaction<T, E>(options: TxOptions | undefined, work: TransactionWork<T, E>): Promise<Result<T, E | DrizzleTxError>> {
  let inFlight: { error: E } | undefined;
  try {
    const value = await this.#adapter.wrapWithTransaction(options, (tx) =>
      this.#ctx.run(tx, async () => {
        const r = await work();
        if (!r.ok) inFlight = { error: r.error };
        return toThrowable(r);
      }),
    );
    return ok(value);
  } catch (e) {
    return classifyRollback<E>(e, inFlight);
  }
}
```

Apply the identical change to `#nested` (using `wrapWithNestedTransaction`).

Then fix the **production caller** broken by Task 1's signature change — `packages/core/src/transaction-scope.ts:60`:

```ts
// BEFORE:
? err(transactionAborted(new Error('transaction closed before it started')))
// AFTER:
? err(transactionAborted({
    message: 'transaction closed before it started',
    sqlState: undefined,
    cause: new Error('transaction closed before it started'),
  }))
```

(This is why `transaction-scope.test.ts:78`'s `String(error.cause)` assertion keeps passing — `cause` now carries the real `Error` whose `.toString()` contains the phrase; a bare spread of an `Error` into the old object would have lost it.)

- [ ] **Step 4: Run test to verify pass + no regressions**

Run: `pnpm exec vitest run --project core-unit test/unit/transaction-manager.test.ts`
Expected: PASS for both new tests.
Run: `pnpm test:unit`
Expected: PASS — no regression across the core unit suite. Update any remaining `transactionAborted(cause)`→`transactionAborted(fields)` call sites the suite exercises (e.g. `test/unit/transaction-scope.test.ts`'s two `transactionAborted(new Error(...))` calls at lines ~55/66 and its `Runner` type alias), per the Assumptions.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transaction-manager.ts packages/core/src/transaction-scope.ts \
        packages/core/test/unit/transaction-manager.test.ts packages/core/test/unit/transaction-scope.test.ts
git commit -m "feat(core): preserve swallowed domain error as lostDomainError on rollback double-fault (ADR-0012 §2, R2)"
```

---

### Task 4: R1 — COMMIT-may-err contract (JSDoc + real-DB test)

**Files:**
- Modify: `packages/core/src/transaction-manager.ts` (JSDoc only)
- Test: `packages/core/test/integration/propagation.integration.test.ts`

**Depends on Task 2.** ADR-0012 R1: a work fn returning `ok(value)` can still resolve to `err(...)` because COMMIT runs inside drizzle's try. The deferred-constraint case is a **real-Postgres** test needing no fault injection. **Requires Docker** (`pnpm test:int`).

- [ ] **Step 1: Write the failing integration test**

Add to `packages/core/test/integration/propagation.integration.test.ts`, using its **real** harness (verified): module-level `manager: TransactionManager<any>`, `db` (the `createTransactionalClient` proxy), and `t: TestDb` with `t.pool.query(...)` for raw SQL/DDL. There is **no** `tx` binding, no `sql` import, and no `createDrizzleTx` in this file, and `beforeEach` only truncates `users, accounts` — so create the table with `IF NOT EXISTS` and drop it in the test (no per-test DDL teardown exists). Add `import { sql } from 'drizzle-orm';` at the top (drizzle is already a dep).

```ts
it('R1: ok-returning work still errs when a DEFERRED constraint fails at COMMIT', async () => {
  // DDL via the raw pool (the proxy is for the query builder; DDL has no builder here).
  await t.pool.query(`CREATE TABLE IF NOT EXISTS r1_defer (id int PRIMARY KEY, ref int,
    CONSTRAINT r1_fk FOREIGN KEY (ref) REFERENCES r1_defer(id) DEFERRABLE INITIALLY DEFERRED)`);
  try {
    const r = await manager.withTransaction(async () => {
      await db.execute(sql`INSERT INTO r1_defer (id, ref) VALUES (1, 999)`); // ref 999 absent
      return ok('inserted'); // work says commit — COMMIT then fails on the deferred FK
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 23503 foreign_key_violation isn't in a named-variant class → TransactionAborted, sqlState carried:
    expect(r.error).toMatchObject({ kind: 'TransactionAborted', sqlState: '23503' });
  } finally {
    await t.pool.query('DROP TABLE IF EXISTS r1_defer');
  }
});
```

(`db.execute(sql\`…\`)` runs inside the ALS tx because the work callback is under `manager.withTransaction` — the proxy auto-joins, exactly as this file's first test relies on.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project core-integration propagation.integration.test.ts` (needs Docker; equivalently `pnpm test:int` then filter). 
Expected: after Task 2, this should **PASS on first run** — the boundary already classifies the commit-time `DatabaseError` (23503) into `TransactionAborted` with `sqlState` carried, so this is a **characterization test** locking R1 in. If it instead FAILS because `sqlState` is `undefined` or `kind` is wrong, that's a real Task-2 classification gap — fix Task 2, not the test.

- [ ] **Step 3: Document R1 on the public methods**

Add JSDoc to `withTransaction` (and note on `begin`) in `transaction-manager.ts`:

```ts
/** NOTE (R1, ADR-0012): a work fn returning `ok(value)` can still resolve to `err(...)` —
 *  COMMIT runs inside the transaction boundary, so a deferred-constraint or serialization
 *  failure at commit surfaces as the classified variant (e.g. SerializationFailure at commit). */
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm exec vitest run --project core-integration propagation.integration.test.ts`
Expected: PASS for `R1: ok-returning work still errs when a DEFERRED constraint fails at COMMIT`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transaction-manager.ts packages/core/test/integration/propagation.integration.test.ts
git commit -m "test(core): R1 COMMIT-may-err deferred-constraint integration test + JSDoc (ADR-0012)"
```

---

### Task 5: G5 — extract one `#runInBoundary` + immutable-store JSDoc (ADR-0013 §3/§4)

**Files:**
- Modify: `packages/core/src/transaction-manager.ts`, `packages/core/src/transaction-context.ts` (JSDoc)
- Test: `packages/core/test/unit/transaction-manager.test.ts` (no new behavior — a green refactor)

**Depends on Tasks 3 & 4** (the boundary shape is now stable — the stash + classification are in both shells, so extracting once won't need re-extraction; ADR-0013 §4). This is a **decision-free green refactor**: behavior identical, the whole existing suite is the safety net.

- [ ] **Step 1: Confirm the safety net is green before refactoring**

Run: `pnpm test:unit`
Expected: PASS (baseline before the refactor — the tests that will prove behavior is unchanged).

- [ ] **Step 2: Extract `#runInBoundary`**

Replace the two near-identical `#newTransaction`/`#nested` bodies with one private helper taking the adapter-wrap thunk; both call it:

```ts
/** The one transaction boundary: enter the adapter's wrap, run `work` in an immutable ALS
 *  context, translate err↔throw, and classify any caught failure — preserving a shadowed
 *  domain error (R2). Both new-root and nested transactions run through HERE (ADR-0013 §4),
 *  so the future lifecycle-observation seam and the retry loop attach in ONE place. */
async #runInBoundary<T, E>(
  wrap: (run: (client: TClient) => Promise<T>) => Promise<T>,
  work: TransactionWork<T, E>,
): Promise<Result<T, E | DrizzleTxError>> {
  let inFlight: { error: E } | undefined;
  try {
    const value = await wrap((client) =>
      this.#ctx.run(client, async () => {
        const r = await work();
        if (!r.ok) inFlight = { error: r.error };
        return toThrowable(r);
      }),
    );
    return ok(value);
  } catch (e) {
    return classifyRollback<E>(e, inFlight);
  }
}
```

Wire the two call sites — `work` is the explicit second parameter (no free variable):

```ts
#newTransaction<T, E>(options: TxOptions | undefined, work: TransactionWork<T, E>) {
  return this.#runInBoundary<T, E>((run) => this.#adapter.wrapWithTransaction(options, run), work);
}
#nested<T, E>(work: TransactionWork<T, E>) {
  const parent = this.getTransactionClient();
  return this.#runInBoundary<T, E>((run) => this.#adapter.wrapWithNestedTransaction(parent, run), work);
}
```

- [ ] **Step 3: Add the immutable-store invariant JSDoc (ADR-0013 §3)**

In `transaction-context.ts`, expand the class JSDoc to state the load-bearing invariant verbatim in spirit:

```ts
/** ADR-0013 §3 (load-bearing): the store is immutable — `ActiveTx` is constructed once with
 *  readonly fields only, "presence == active", no setter, no `active` flag. Any future lifecycle
 *  machinery (hooks/OTel/retry) attaches BESIDE this store keyed by tx-identity — NEVER as a
 *  mutable collection inside it. Metadata added later (depth/mode) must be readonly-only. */
```

- [ ] **Step 4: Run the full suite to prove behavior is unchanged**

Run: `pnpm test:unit`
Expected: PASS — identical results to Step 1 (the R2 test, classification, propagation unit tests all still green through the single boundary).
Run: `pnpm typecheck` (after `pnpm build`, per CLAUDE.md — nestjs typechecks against core's built dist)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/transaction-manager.ts packages/core/src/transaction-context.ts
git commit -m "refactor(core): extract one #runInBoundary from the duplicate shells (G5) + document immutable-store invariant (ADR-0013)"
```

---

### Task 6: Gate — full verification before this plan is done

**Files:** none (verification only).

- [ ] **Step 1: Full test + typecheck + publish check**

Run: `pnpm build`
Expected: both packages build (tsdown core dual ESM+CJS, tsc nestjs).
Run: `pnpm typecheck`
Expected: PASS (incl. `tsconfig.test-d.json` exhaustiveness fixtures).
Run: `pnpm test` (unit + core-integration + nestjs; needs Docker)
Expected: PASS across all Vitest projects.
Run: `pnpm -r run check:publish`
Expected: PASS — `publint --strict` + `attw` clean (the new error exports resolve in both ESM and CJS).

- [ ] **Step 2: Confirm the ADR-0012 status can flip on the follow-up PR**

Note (do not edit here): `CONTEXT.md`'s `DrizzleTxError` entry and ADR-0012's `Status:` line update in the same PR that ships this — flip them when merging, not before (plan-don't-do: no documenting an unshipped shape ahead of code).

---

## Downstream (later plans — NOT in this plan)

- The `sqlState`/`kind` this plan produces is what **#28 FaultInjectingDrizzleAdapter** injects and **T2** failure-scenario tests assert (COMMIT-fails / ROLLBACK-loses-E via `lostDomainError` / savepoint-failure / conn-loss). Those are the next plan.
- The `#runInBoundary` single seam this plan creates is where the **hooks/OTel observer** and the **retry loop** will later attach (ADR-0013 — event API deferred).
