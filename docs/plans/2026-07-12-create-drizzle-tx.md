# `createDrizzleTx` Canonical Assembly Path Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use the repo's available execution skill when one exists (for example, `executing-plans`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `createDrizzleTx({ drizzle })` to `@drizzle-tx/core` as the single non-DI assembly path returning `{ db, withTransaction, begin, isActive, manager }`, gate it against non-interactive drivers (Neon HTTP) with a construction-time throw, and refactor the NestJS module to delegate to it.

**Architecture:** A pure, DB-free `driver-capability.ts` module (ADR-0006 functional core) detects known non-interactive drizzle drivers by reading the global-registry symbol `Symbol.for("drizzle:entityKind")` off the instance's class chain — no `drizzle-orm` import (honoring core's optional-peer stance). `createDrizzleTx` (the imperative shell) calls the detector and `throw`s `UnsupportedDriverError` (a dedicated class, **not** a `DrizzleTxError` union variant) before wiring the existing `TransactionManager` + `DrizzleAdapter` + `createTransactionalClient` exactly as today. The NestJS module delegates to a single `createDrizzleTx` call so defaults can't drift.

**Tech Stack:** TypeScript (ESM, `erasableSyntaxOnly`), tsdown (core build), Vitest 4 (`core-unit` project, no DB), `tsc` type-level tests (`tsconfig.test-d.json`), Changesets.

**Design sources:** Issue #11, [ADR-0009](../adr/0009-framework-adapters-node-only-and-result-throw-bridge.md), [ADR-0010](../adr/0010-driver-capability-gate-throws-at-assembly.md), [CONTEXT.md](../../CONTEXT.md) → **Assembly**.

**Assumptions:**
- `UnsupportedDriverError` and the detector co-locate in one module `driver-capability.ts` (flat layout, one file per module). The detector functions stay **internal** (tests import from `../../src/...` directly); only `createDrizzleTx`, its types, and `UnsupportedDriverError` are re-exported from `index.ts`.
- The NestJS refactor constructs the assembly **exactly once** via a new internal token `DRIZZLE_TX_ASSEMBLY`, from which the `DRIZZLE_TX_MANAGER` / `DRIZZLE_TX_CLIENT` providers select `.manager` / `.db` — two `createDrizzleTx` calls would create two `AsyncLocalStorage` contexts.
- Changeset: `@drizzle-tx/core` **minor** (additive feature), `@drizzle-tx/nestjs` **patch** (behavior-preserving internal refactor).
- Commits are single-and-final (matches the repo's feature-grained history); per-task commits are optional.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `packages/core/src/driver-capability.ts` | Create | Pure `readDrizzleEntityKind` + `assertInteractiveCapable` detector; `UnsupportedDriverError` class; the extensible non-interactive denylist. |
| `packages/core/src/create-drizzle-tx.ts` | Create | `createDrizzleTx` factory; `CreateDrizzleTxOptions` + `DrizzleTx` types. |
| `packages/core/src/index.ts` | Modify | Re-export `createDrizzleTx`, `CreateDrizzleTxOptions`, `DrizzleTx`, `UnsupportedDriverError`. |
| `packages/core/test/unit/driver-capability.test.ts` | Create | Unit tests for the detector + error (fake entityKind classes, no DB). |
| `packages/core/test/unit/create-drizzle-tx.test.ts` | Create | Unit tests for the factory (gate throw, `db` auto-join, bound-method survival). |
| `packages/core/test/types/create-drizzle-tx.test-d.ts` | Create | Type-level test: return shape + `withTransaction` overloads/`Result<T, E \| DrizzleTxError>` union survive. |
| `packages/nestjs/src/tokens.ts` | Modify | Add internal `DRIZZLE_TX_ASSEMBLY` token. |
| `packages/nestjs/src/drizzle-transaction.module.ts` | Modify | Delegate providers to `createDrizzleTx`; drop hand-constructed `TransactionManager`/`DrizzleAdapter`. |
| `packages/core/README.md` | Modify | Document the driver matrix alongside `createDrizzleTx`. |
| `.changeset/create-drizzle-tx.md` | Create | Changeset (core minor, nestjs patch). |

---

## Task 1: `driver-capability.ts` — pure detector + `UnsupportedDriverError` (riskiest: prototype-walk correctness)

**Files:**
- Create: `packages/core/src/driver-capability.ts`
- Test: `packages/core/test/unit/driver-capability.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/driver-capability.test.ts
import { describe, expect, it } from 'vitest';
import {
  assertInteractiveCapable,
  readDrizzleEntityKind,
  UnsupportedDriverError,
} from '../../src/driver-capability.js';

// drizzle tags its DB classes with a STATIC global-registry symbol.
const ENTITY_KIND = Symbol.for('drizzle:entityKind');
class NeonHttpDatabase {
  static [ENTITY_KIND] = 'NeonHttpDatabase';
}
class NodePgDatabase {
  static [ENTITY_KIND] = 'NodePgDatabase';
}
class NeonHttpSubclass extends NeonHttpDatabase {} // no own entityKind → inherits parent's

describe('readDrizzleEntityKind', () => {
  it('reads the most-derived entityKind off the instance class chain', () => {
    expect(readDrizzleEntityKind(new NeonHttpDatabase())).toBe('NeonHttpDatabase');
    expect(readDrizzleEntityKind(new NodePgDatabase())).toBe('NodePgDatabase');
  });

  it('walks up to an inherited entityKind when the subclass has none', () => {
    expect(readDrizzleEntityKind(new NeonHttpSubclass())).toBe('NeonHttpDatabase');
  });

  it('returns undefined for clients with no entityKind', () => {
    expect(readDrizzleEntityKind({ transaction() {} })).toBeUndefined(); // hand-rolled client
    expect(readDrizzleEntityKind(null)).toBeUndefined();
    expect(readDrizzleEntityKind(undefined)).toBeUndefined();
    expect(readDrizzleEntityKind(42)).toBeUndefined();
  });
});

describe('assertInteractiveCapable', () => {
  it('throws UnsupportedDriverError for a known non-interactive driver (Neon HTTP)', () => {
    expect(() => assertInteractiveCapable(new NeonHttpDatabase())).toThrow(UnsupportedDriverError);
    try {
      assertInteractiveCapable(new NeonHttpDatabase());
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedDriverError);
      expect((e as UnsupportedDriverError).driver).toBe('NeonHttpDatabase');
      expect((e as UnsupportedDriverError).name).toBe('UnsupportedDriverError');
      expect((e as UnsupportedDriverError).message).toMatch(/neon-serverless/i);
    }
  });

  it('throws for a subclass of a non-interactive driver', () => {
    expect(() => assertInteractiveCapable(new NeonHttpSubclass())).toThrow(UnsupportedDriverError);
  });

  it('does NOT throw for interactive drivers or hand-rolled / testing clients', () => {
    expect(() => assertInteractiveCapable(new NodePgDatabase())).not.toThrow();
    expect(() => assertInteractiveCapable({ transaction() {} })).not.toThrow(); // no entityKind
    expect(() => assertInteractiveCapable(null)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/core/test/unit/driver-capability.test.ts`
Expected: FAIL — module `../../src/driver-capability.js` does not exist (import/resolve error).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/driver-capability.ts

/** drizzle-orm tags every DB class with this GLOBAL-registry symbol
 *  (`Symbol.for("drizzle:entityKind")`), so we can read it without importing
 *  drizzle-orm — keeping core's optional-peer stance (ADR-0010). */
const ENTITY_KIND = Symbol.for('drizzle:entityKind');

/** Known drizzle `entityKind`s that cannot host ANY interactive transaction.
 *  Extensible: add a new *non-interactive* driver's kind here (denylist — new
 *  *interactive* drivers need no change). See ADR-0010 / ADR-0009 driver matrix. */
const NON_INTERACTIVE_ENTITY_KINDS: ReadonlySet<string> = new Set(['NeonHttpDatabase']);

/** Thrown at assembly time (not a `DrizzleTxError` runtime variant — ADR-0010) when a
 *  driver cannot host interactive transactions. `driver` is the offending entityKind. */
export class UnsupportedDriverError extends Error {
  readonly driver: string;
  constructor(driver: string) {
    super(
      `@drizzle-tx: driver "${driver}" cannot host interactive transactions. ` +
        'Neon HTTP is one-shot / non-interactive — use drizzle-orm/neon-serverless ' +
        '(WebSocket Pool) or node-postgres instead.',
    );
    this.name = 'UnsupportedDriverError';
    this.driver = driver;
  }
}

/** Read the most-derived drizzle `entityKind` off a client's class chain, mirroring
 *  drizzle's own `is()` walk. Returns `undefined` for non-drizzle / non-object values. */
export function readDrizzleEntityKind(client: unknown): string | undefined {
  if (client === null || (typeof client !== 'object' && typeof client !== 'function')) {
    return undefined;
  }
  let cls: unknown = Object.getPrototypeOf(client)?.constructor;
  while (cls) {
    const kind = (cls as Record<PropertyKey, unknown>)[ENTITY_KIND];
    if (typeof kind === 'string') return kind;
    cls = Object.getPrototypeOf(cls);
  }
  return undefined;
}

/** Throw `UnsupportedDriverError` if `client` is a known non-interactive driver.
 *  No-op for interactive, hand-rolled, or testing clients. */
export function assertInteractiveCapable(client: unknown): void {
  const kind = readDrizzleEntityKind(client);
  if (kind !== undefined && NON_INTERACTIVE_ENTITY_KINDS.has(kind)) {
    throw new UnsupportedDriverError(kind);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/core/test/unit/driver-capability.test.ts`
Expected: PASS for all tests in `readDrizzleEntityKind` and `assertInteractiveCapable`.

- [ ] **Step 5: Refactor if needed**

Change: none expected. Confirm no `throw` outside `assertInteractiveCapable` (the module stays a pure decision module per ADR-0006, except the one asserting helper).
Run: `pnpm exec vitest run packages/core/test/unit/driver-capability.test.ts`
Expected: PASS.

---

## Task 2: `create-drizzle-tx.ts` — the factory (Depends on Task 1)

**Files:**
- Create: `packages/core/src/create-drizzle-tx.ts`
- Test: `packages/core/test/unit/create-drizzle-tx.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/create-drizzle-tx.test.ts
import { describe, expect, it } from 'vitest';
import { createDrizzleTx } from '../../src/create-drizzle-tx.js';
import { UnsupportedDriverError } from '../../src/driver-capability.js';
import { ok } from '../../src/result.js';

const ENTITY_KIND = Symbol.for('drizzle:entityKind');

/** A fake Pool-backed drizzle client: `.transaction(fn)` runs `fn` against a distinct
 *  "tx" client so we can observe the transactional-client auto-join. `$client` carries
 *  the structural pool markers `DrizzleAdapter.isPoolBacked` looks for. */
function makeFakeDrizzle() {
  const $client = { totalCount: 1, idleCount: 1, connect() {} };
  const makeClient = (label: 'base' | 'tx'): any => ({
    label,
    $client,
    transaction(fn: (tx: any) => Promise<unknown>) {
      return fn(makeClient('tx'));
    },
  });
  return makeClient('base');
}

describe('createDrizzleTx', () => {
  it('returns the documented shape', () => {
    const tx = createDrizzleTx({ drizzle: makeFakeDrizzle() });
    expect(typeof tx.withTransaction).toBe('function');
    expect(typeof tx.begin).toBe('function');
    expect(typeof tx.isActive).toBe('function');
    expect(tx.manager).toBeDefined();
    expect(tx.db).toBeDefined();
  });

  it('db resolves to the base client outside a transaction', () => {
    const tx = createDrizzleTx({ drizzle: makeFakeDrizzle() });
    expect((tx.db as any).label).toBe('base');
    expect(tx.isActive()).toBe(false);
  });

  it('db auto-joins the active transaction inside withTransaction', async () => {
    const tx = createDrizzleTx({ drizzle: makeFakeDrizzle() });
    let seenInside: string | undefined;
    const result = await tx.withTransaction(async () => {
      seenInside = (tx.db as any).label; // resolves live to the tx client
      return ok(123);
    });
    expect(seenInside).toBe('tx');
    expect(result).toEqual({ ok: true, value: 123 });
    expect((tx.db as any).label).toBe('base'); // back to base after the tx
  });

  it('bound methods survive destructuring (this-binding preserved)', async () => {
    const { withTransaction, isActive } = createDrizzleTx({ drizzle: makeFakeDrizzle() });
    expect(isActive()).toBe(false); // would throw on private-field access if `this` were lost
    await expect(withTransaction(async () => ok('done'))).resolves.toEqual({
      ok: true,
      value: 'done',
    });
  });

  it('throws UnsupportedDriverError at construction for a non-interactive driver', () => {
    class NeonHttpDatabase {
      static [ENTITY_KIND] = 'NeonHttpDatabase';
      $client = () => {}; // neon-http $client is the neon() function
      transaction() {
        throw new Error('No transactions support in neon-http driver');
      }
    }
    expect(() => createDrizzleTx({ drizzle: new NeonHttpDatabase() as any })).toThrow(
      UnsupportedDriverError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/core/test/unit/create-drizzle-tx.test.ts`
Expected: FAIL — module `../../src/create-drizzle-tx.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/create-drizzle-tx.ts
import { DrizzleAdapter, type DrizzleTxCapable } from './adapters/drizzle.js';
import { assertInteractiveCapable } from './driver-capability.js';
import { TransactionManager, type TransactionManagerOptions } from './transaction-manager.js';
import { createTransactionalClient } from './transactional-client.js';

export interface CreateDrizzleTxOptions<TClient extends DrizzleTxCapable>
  extends TransactionManagerOptions {
  /** The base client: a Drizzle instance (node-postgres / neon-serverless / postgres-js …). */
  readonly drizzle: TClient;
}

/** The single canonical assembly result. Types for `withTransaction` / `begin` / `isActive`
 *  are indexed off `TransactionManager` so the 4 `withTransaction` overloads and the
 *  `Result<T, E | DrizzleTxError>` union are preserved through the factory (ADR-0010, Q4). */
export interface DrizzleTx<TClient extends DrizzleTxCapable> {
  /** The transactional client (auto-joins the active tx; else the base client). Import in repositories. */
  readonly db: TClient;
  readonly manager: TransactionManager<TClient>;
  readonly withTransaction: TransactionManager<TClient>['withTransaction'];
  readonly begin: TransactionManager<TClient>['begin'];
  readonly isActive: TransactionManager<TClient>['isTransactionActive'];
}

/** The single non-DI assembly path — every surface (NestJS, tRPC, Next) builds on this so
 *  defaults can't drift. Throws `UnsupportedDriverError` at construction if `drizzle` is a
 *  driver that cannot host interactive transactions (Neon HTTP). See the driver matrix in
 *  the package README and ADR-0009 / ADR-0010.
 *
 *  | Driver | Interactive tx |
 *  |---|---|
 *  | node-postgres `pg.Pool` | ✅ full |
 *  | neon-serverless (WebSocket Pool) | ✅ full |
 *  | neon-http | ❌ hard-unsupported — throws here |
 *  | PgBouncer / Supavisor txn mode | ⚠️ `REQUIRED` ok (`prepare:false`); `REQUIRES_NEW` doubles backend pressure |
 */
export function createDrizzleTx<TClient extends DrizzleTxCapable>(
  options: CreateDrizzleTxOptions<TClient>,
): DrizzleTx<TClient> {
  const { drizzle, ...managerOptions } = options;
  assertInteractiveCapable(drizzle);
  const manager = new TransactionManager<TClient>(
    new DrizzleAdapter({ db: drizzle }),
    managerOptions,
  );
  const db = createTransactionalClient<TClient>(() => manager.getTransactionClient());
  return {
    db,
    manager,
    // Runtime `.bind` preserves `this`; the interface's indexed-access types restore the
    // overloaded/generic signatures that `.bind` erases at the type level.
    withTransaction: manager.withTransaction.bind(manager) as DrizzleTx<TClient>['withTransaction'],
    begin: manager.begin.bind(manager),
    isActive: manager.isTransactionActive.bind(manager),
  };
}
```

> If `tsc` complains that `TClient` is not assignable to `createTransactionalClient`'s `object` constraint, widen the factory constraint to `TClient extends DrizzleTxCapable & object`. Run the typecheck in Task 4 to confirm.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/core/test/unit/create-drizzle-tx.test.ts`
Expected: PASS for all five tests (shape, base-resolve, auto-join, destructured binding, gate throw).

- [ ] **Step 5: Refactor if needed**

Change: none expected. Confirm the factory adds no logic beyond gate + wire (behavior identical to the hand-wired path it replaces).
Run: `pnpm exec vitest run packages/core/test/unit/create-drizzle-tx.test.ts`
Expected: PASS.

---

## Task 3: Type-level test — return shape + `withTransaction` union/overloads survive (Depends on Task 2)

**Files:**
- Create: `packages/core/test/types/create-drizzle-tx.test-d.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/types/create-drizzle-tx.test-d.ts
import type { DrizzleTxCapable } from '../../src/adapters/drizzle.js';
import { createDrizzleTx } from '../../src/create-drizzle-tx.js';
import type { DrizzleTxError } from '../../src/errors.js';
import { err, ok, type Result } from '../../src/result.js';
import type { TransactionScope } from '../../src/transaction-scope.js';

// A typed fake base client — the transactional client `db` must carry the SAME type.
declare const fakeDrizzle: DrizzleTxCapable & { select(): 'rows' };
const tx = createDrizzleTx({ drizzle: fakeDrizzle });

// `db` is typed identically to the base client (repos get full drizzle typing).
const _dbSelect: 'rows' = tx.db.select();

// `isActive` returns boolean.
const _active: boolean = tx.isActive();

async function surfaces(): Promise<void> {
  // Overload 1 (work only) must still compile — proves `.bind` did NOT collapse overloads.
  const r1 = await tx.withTransaction(async () => err({ kind: 'SoldOut' } as const));
  // The domain error union is preserved alongside DrizzleTxError.
  const _keep: Result<never, { kind: 'SoldOut' } | DrizzleTxError> = r1;
  // @ts-expect-error — the domain error must NOT be swallowed into just DrizzleTxError.
  const _collapsed: Result<never, DrizzleTxError> = r1;

  // Overload 2 (propagation, work) must still compile.
  const r2 = await tx.withTransaction('REQUIRES_NEW', async () => ok(1));
  const _r2: Result<number, DrizzleTxError> = r2;

  // `begin` returns the scope Result.
  const opened = await tx.begin();
  const _scope: Result<TransactionScope<typeof fakeDrizzle>, DrizzleTxError> = opened;
}
void surfaces;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @drizzle-tx/core exec tsc --noEmit -p tsconfig.test-d.json`
Expected: FAIL — cannot find module `../../src/create-drizzle-tx.js` (until Task 2 exists) or an unsatisfied `@ts-expect-error` if the union were collapsed. (If Task 2 is already implemented, this fails only if the types are wrong.)

- [ ] **Step 3: Write minimal implementation**

No production code — this task asserts the types produced in Task 2. If the test reports a *real* type error (e.g. overloads collapsed, or `_collapsed` compiles so the `@ts-expect-error` is unused), fix the `DrizzleTx` interface in `packages/core/src/create-drizzle-tx.ts` (indexed-access types) until the assertions hold.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @drizzle-tx/core exec tsc --noEmit -p tsconfig.test-d.json`
Expected: PASS (exit 0) — all existing `*.test-d.ts` plus the new one typecheck; the single `@ts-expect-error` is satisfied.

---

## Task 4: Export from `index.ts` + build core (Depends on Tasks 2–3)

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the public exports**

Add to `packages/core/src/index.ts` (alphabetical-ish, near the other `create*` export):

```ts
export {
  createDrizzleTx,
  type CreateDrizzleTxOptions,
  type DrizzleTx,
} from './create-drizzle-tx.js';
export { UnsupportedDriverError } from './driver-capability.js';
```

(Do **not** export `readDrizzleEntityKind` / `assertInteractiveCapable` — internal.)

- [ ] **Step 2: Typecheck the package**

Run: `pnpm --filter @drizzle-tx/core exec tsc --noEmit -p tsconfig.json`
Expected: PASS (exit 0). If it fails on the `createTransactionalClient` `object` constraint, apply the `& object` widening noted in Task 2 Step 3 and re-run.

- [ ] **Step 3: Build core (required before NestJS typechecks/tests against dist)**

Run: `pnpm --filter @drizzle-tx/core build`
Expected: tsdown emits `dist/index.js` + `dist/index.cjs` + `dist/index.d.ts` + `dist/index.d.cts` with no errors.

- [ ] **Step 4: Run the full core unit suite (no regressions)**

Run: `pnpm test:unit`
Expected: PASS — all `core-unit` files including the two new ones.

---

## Task 5: NestJS module delegates to `createDrizzleTx` (Depends on Task 4)

**Files:**
- Modify: `packages/nestjs/src/tokens.ts`
- Modify: `packages/nestjs/src/drizzle-transaction.module.ts`
- Test: existing `packages/nestjs/test/unit/module.test.ts` + full nestjs suites (behavior-preserving — no new test file)

- [ ] **Step 1: Add the internal assembly token**

Add to `packages/nestjs/src/tokens.ts`:

```ts
/** Internal — the single `createDrizzleTx` assembly, constructed once. Not part of the
 *  public token surface (not re-exported from the package index). */
export const DRIZZLE_TX_ASSEMBLY = Symbol.for('drizzle-tx:assembly');
```

- [ ] **Step 2: Refactor the providers to delegate**

In `packages/nestjs/src/drizzle-transaction.module.ts`:

Replace the import block from core:
```ts
import {
  createDrizzleTx,
  type DrizzleTx,
  type DrizzleTxCapable,
} from '@drizzle-tx/core';
```
(Remove `DrizzleAdapter`, `TransactionManager`, `createTransactionalClient` — no longer used.)

Add `DRIZZLE_TX_ASSEMBLY` to the tokens import:
```ts
import {
  DRIZZLE_BASE_DB,
  DRIZZLE_TX_ASSEMBLY,
  DRIZZLE_TX_CLIENT,
  DRIZZLE_TX_MANAGER,
} from './tokens.js';
```

Replace the two hand-constructed providers in `build(...)` with an assembly + two selectors (construct once):
```ts
providers: [
  baseDbProvider,
  {
    provide: DRIZZLE_TX_ASSEMBLY,
    inject: [DRIZZLE_BASE_DB],
    useFactory: (db: DrizzleTxCapable) => createDrizzleTx({ drizzle: db }),
  },
  {
    provide: DRIZZLE_TX_MANAGER,
    inject: [DRIZZLE_TX_ASSEMBLY],
    useFactory: (tx: DrizzleTx<DrizzleTxCapable>) => tx.manager,
  },
  {
    provide: DRIZZLE_TX_CLIENT,
    inject: [DRIZZLE_TX_ASSEMBLY],
    useFactory: (tx: DrizzleTx<DrizzleTxCapable>) => tx.db,
  },
  TransactionHost,
],
exports: [DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER, DRIZZLE_BASE_DB, TransactionHost],
```
(`DRIZZLE_TX_ASSEMBLY` is intentionally **not** exported — internal wiring only. `exports` is unchanged.)

- [ ] **Step 3: Typecheck NestJS against the freshly built core**

Run: `pnpm --filter @drizzle-tx/nestjs exec tsc --noEmit -p tsconfig.json`
Expected: PASS (exit 0).

- [ ] **Step 4: Run the NestJS unit suite (behavior preserved)**

Run: `pnpm exec vitest run --project nestjs-unit`
Expected: PASS — `module.test.ts`, `di-smoke.test.ts`, `inject.test.ts`, `transaction-host.test.ts`, `transactional-host-miss.test.ts`, etc. all green with no source changes to the tests.

- [ ] **Step 5: Run the NestJS integration suite (real Postgres — needs Docker)**

Run: `pnpm test:nestjs`
Expected: PASS — both `nestjs-unit` and `nestjs-integration` projects green (transaction propagation/rollback unchanged end-to-end).

---

## Task 6: Docs (driver matrix) + changeset + full verification

**Files:**
- Modify: `packages/core/README.md`
- Create: `.changeset/create-drizzle-tx.md`

- [ ] **Step 1: Document `createDrizzleTx` + the driver matrix in the core README**

In `packages/core/README.md`, add a `createDrizzleTx` bullet to "What's in the box" and a new section after "Usage" (place near the existing `DrizzleAdapter`/`createTransactionalClient` docs):

```markdown
### `createDrizzleTx` — the canonical assembly path

```ts
import { createDrizzleTx } from '@drizzle-tx/core';
import { drizzle } from 'drizzle-orm/node-postgres';

export const { db, withTransaction, begin, isActive, manager } = createDrizzleTx({
  drizzle: drizzle({ client: pool, relations }),
});
// `db` is the transactional client (auto-joins the active tx) — import it in repositories.
```

One factory wires the manager, adapter, and transactional client so every surface shares the same defaults.

**Driver matrix** (interactive transactions require a real TCP connection — Node runtime only; ADR-0009):

| Driver | Interactive tx / `REQUIRES_NEW` |
|---|---|
| node-postgres `pg.Pool` | ✅ full — primary target |
| neon-serverless (WebSocket Pool) | ✅ full — serverless-friendly |
| **neon-http** | ❌ **hard-unsupported** — `createDrizzleTx` throws `UnsupportedDriverError` at construction |
| PgBouncer / Supavisor *transaction* mode | ⚠️ `REQUIRED` works with `prepare:false`; `REQUIRES_NEW` draws a 2nd pooled backend |

Neon HTTP is one-shot/non-interactive; switch to `drizzle-orm/neon-serverless` (WebSocket) for transactions.
```

- [ ] **Step 2: Add the changeset**

```markdown
<!-- .changeset/create-drizzle-tx.md -->
---
"@drizzle-tx/core": minor
"@drizzle-tx/nestjs": patch
---

Add `createDrizzleTx({ drizzle })` — the single non-DI canonical assembly path returning `{ db, withTransaction, begin, isActive, manager }`. Constructing against a non-interactive driver (Neon HTTP) now fails fast with a typed `UnsupportedDriverError` at assembly instead of a mysterious runtime throw. The NestJS module now delegates its manager/client providers to `createDrizzleTx`, so defaults can't drift between surfaces (behavior-preserving).
```

- [ ] **Step 3: Full typecheck across the workspace**

Run: `pnpm build && pnpm typecheck`
Expected: PASS — solution build + per-package `tsc --noEmit` including both `tsconfig.test-d.json` files. (Build precedes typecheck because NestJS typechecks against core's built `dist` — CLAUDE.md.)

- [ ] **Step 4: Full test suite**

Run: `pnpm test`
Expected: PASS — `core-unit`, `core-integration`, `nestjs-unit`, `nestjs-integration` (integration needs Docker).

- [ ] **Step 5: Publishing checks for core (new export must resolve in ESM + CJS)**

Run: `pnpm -r run check:publish`
Expected: PASS — `publint --strict` clean and `attw` reports no `createDrizzleTx`/`UnsupportedDriverError` resolution problems across the `import`/`require` conditions.

- [ ] **Step 6: Lint**

Run: `pnpm lint`
Expected: PASS (Biome clean). Run `pnpm lint:fix` if it flags formatting on the new files.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/driver-capability.ts packages/core/src/create-drizzle-tx.ts \
  packages/core/src/index.ts packages/core/test/unit/driver-capability.test.ts \
  packages/core/test/unit/create-drizzle-tx.test.ts \
  packages/core/test/types/create-drizzle-tx.test-d.ts packages/core/README.md \
  packages/nestjs/src/tokens.ts packages/nestjs/src/drizzle-transaction.module.ts \
  .changeset/create-drizzle-tx.md docs/adr/0010-driver-capability-gate-throws-at-assembly.md \
  docs/plans/2026-07-12-create-drizzle-tx.md CONTEXT.md
git commit -m "feat(core): add createDrizzleTx canonical assembly path + driver-capability gate; delegate NestJS module to it"
```

---

## Task Count Check

6 tasks — healthy. Risk front-loaded (Task 1 = the entityKind prototype-walk detector; Task 2 = the gate + binding). Tasks 1 and 2/3 are core-only and could be developed before Task 5 (NestJS), which is the only cross-package task and depends on the built core from Task 4.
