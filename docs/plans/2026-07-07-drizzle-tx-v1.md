# @drizzle-tx v1 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Use the repo's available execution skill when one exists (for example, `subagent-driven-development` or `executing-plans`). Steps use checkbox (`- [ ]`) syntax for tracking. Read `docs/prds/drizzle-tx-v1.0-prd.md`, `CONTEXT.md`, and `docs/adr/000{1..5}-*.md` before starting — they are the source of truth for behavior and terminology.

**Goal:** Ship `@drizzle-tx/core` (framework-agnostic AsyncLocalStorage transaction engine) and `@drizzle-tx/nestjs` (NestJS 11 adapter) with an explicit-Result API, 3 propagation modes, and real-Postgres integration tests.

**Architecture:** A pnpm monorepo. `@drizzle-tx/core` (ESM+CJS via tsdown) holds a `TransactionManager` built on raw `AsyncLocalStorage`, an ORM adapter seam, a tx-aware client `Proxy`, and an explicit `Result`/`DrizzleTxError` model — it never throws for modeled conditions. `@drizzle-tx/nestjs` (CJS via tsc, legacy decorators) wraps it as a NestJS module + `@Transactional` decorator + `TransactionHost`. Tests: Vitest 4, unit tests use a fake adapter; integration tests hit a real Postgres via Testcontainers with a database-per-worker.

**Tech Stack:** TypeScript 6.0.3, tsdown 0.22.3, tsc, Biome 2.5.2, Vitest 4.1.10, unplugin-swc 1.5.9, @swc/core, @testcontainers/postgresql 12.0.4, drizzle-orm 1.0.0-rc.4 + drizzle-kit 1.0.0-rc.4, pg 8.22, NestJS 11, reflect-metadata 0.2, changesets, publint, @arethetypeswrong/cli. Node LTS 24 (dev), CI matrix Node 20/22/24, published `engines: >=20`.

**Assumptions (resolve/confirm inline; documented here so execution doesn't stall):**
- **TypeScript 6.0.3** is used repo-wide. NestJS 11's officially tested range is TS ≥5.3; TS 6 keeps `experimentalDecorators`/`emitDecoratorMetadata`. **Task 1 verifies DI metadata works under TS 6 via both tsc-build and SWC-Vitest**; if it fails, the fallback is to pin `typescript@5.9.3` in the pnpm catalog (single edit) and re-run.
- **Drizzle 1.0 rc.4 relations v2** uses `defineRelations(schema, (r) => ({...}))` passed as `drizzle(client, { relations })`, and `db.query.<relation>` for RQB. **Task 2 validates the exact shape against installed types** before any dependent task; if the API differs, fix the Task-2 schema/query and note it — downstream tasks only use the proxy transparently.
- **ADR-0005** (decorator typed to force `DrizzleTxError` into the method error union) is *enforceable* under legacy decorators. **Task 9 validates this with a type-level test**; if legacy-decorator inference can't enforce it, fall back to: `withTransaction()` is the blessed type-safe path and `@Transactional` ships a documented "include `DrizzleTxError` in your union" rule (still shipped, just convention-checked).
- The base `db` passed to the module is **`Pool`-backed** (ADR-0002). `NotPoolBacked` is detected via `db.$client instanceof pg.Pool`.
- Per-task commits are used (small, reviewable history). Repo is git-init'd in Task 1.

**Out of scope (v1):** SUPPORTS/NOT_SUPPORTED/MANDATORY/NEVER propagation; MySQL/SQLite/sync-driver path; lifecycle hooks; named/multiple connections; Hono/Express adapters. Seams are left for all (see PRD).

---

## File Structure

```
drizzle-nest-transaction/
├── package.json                      # root, private, scripts
├── pnpm-workspace.yaml               # packages + catalog
├── tsconfig.base.json                # shared strict base
├── tsconfig.json                     # solution refs (typecheck all)
├── biome.json                        # format + lint (v2)
├── vitest.config.ts                  # root: unit + integration projects
├── vitest.globalSetup.ts             # Testcontainers Postgres (once)
├── vitest.dbPerWorker.ts             # per-worker DB create+migrate helper
├── .changeset/config.json
├── .nvmrc                            # 24
├── .github/workflows/ci.yml
├── .github/workflows/release.yml
├── packages/
│   ├── core/
│   │   ├── package.json              # @drizzle-tx/core, exports map, tsdown build
│   │   ├── tsconfig.json             # modern: nodenext, isolatedDeclarations
│   │   ├── tsdown.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       ├── result.ts             # Result, ok, err, assertNever
│   │       ├── errors.ts             # DrizzleTxError union + factories
│   │       ├── propagation.ts        # Propagation const-union
│   │       ├── options.ts            # TxOptions
│   │       ├── logger.ts             # TxLogger seam
│   │       ├── adapter.ts            # TransactionAdapter interface
│   │       ├── transaction-manager.ts# ALS engine + propagation switch
│   │       ├── drizzle-adapter.ts    # pg async adapter (+ NotPoolBacked detect)
│   │       └── transactional-client.ts # tx-aware Proxy
│   └── nestjs/
│       ├── package.json              # @drizzle-tx/nestjs, tsc build (CJS)
│       ├── tsconfig.json             # decorators: experimental + emitMetadata
│       ├── vitest.config.ts          # unplugin-swc for decorator metadata
│       └── src/
│           ├── index.ts
│           ├── tokens.ts
│           ├── transaction-host.ts   # imperative API + static registry
│           ├── transactional.decorator.ts
│           ├── inject.ts             # InjectTransactionalClient/Host
│           └── drizzle-transaction.module.ts
└── test/
    └── schema.ts                     # shared test schema (defineRelations)
```

**Test file locations:** unit tests co-located as `src/**/*.test.ts` (no DB); integration tests as `src/**/*.integration.test.ts` and `packages/nestjs/src/**/*.integration.test.ts` (real Postgres). Type-level tests as `src/**/*.test-d.ts` checked via `tsc --noEmit`.

---

## Task 1: Monorepo scaffold + toolchain + smoke tests (incl. TS6/decorator de-risk)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `biome.json`, `.nvmrc`, `.gitignore` (exists), `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/tsdown.config.ts`, `packages/core/src/index.ts`, `packages/core/src/smoke.test.ts`
- Create: `packages/nestjs/package.json`, `packages/nestjs/tsconfig.json`, `packages/nestjs/vitest.config.ts`, `packages/nestjs/src/index.ts`, `packages/nestjs/src/di-smoke.integration.test.ts` (no DB; validates decorator metadata)

- [ ] **Step 1: Git init + workspace root**

```bash
cd /home/alifarooq/Desktop/drizzle-nest-transaction && git init
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'

catalog:
  typescript: 6.0.3
  drizzle-orm: 1.0.0-rc.4
  drizzle-kit: 1.0.0-rc.4
  vitest: 4.1.10
  '@vitest/coverage-v8': 4.1.10
  pg: ^8.22.0
  '@types/pg': ^8.20.0
  reflect-metadata: ^0.2.2
  rxjs: ^7.8.1
  '@nestjs/common': ^11.0.0
  '@nestjs/core': ^11.0.0
  '@testcontainers/postgresql': ^12.0.4
```

Create root `package.json`:

```json
{
  "name": "drizzle-tx-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r run build",
    "typecheck": "tsc -b tsconfig.json && pnpm -r run typecheck",
    "test": "vitest run",
    "test:unit": "vitest run --project core-unit",
    "test:int": "vitest run --project core-integration",
    "test:nestjs": "vitest run --project nestjs",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "check:publish": "pnpm -r run check:publish"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.2",
    "@changesets/cli": "^2.31.0",
    "@types/node": "^24.0.0",
    "typescript": "catalog:",
    "vitest": "catalog:",
    "@vitest/coverage-v8": "catalog:"
  }
}
```

- [ ] **Step 2: Shared configs**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

> `noFallthroughCasesInSwitch` guards the propagation switch in the manager.

Create `biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.2/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/dist", "!**/.reference"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "javascript": { "formatter": { "quoteStyle": "single", "trailingCommas": "all" } }
}
```

Create `.nvmrc` with `24`. Create root `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Core unit tests only (no decorators, no DB).
        // NOTE: the `*.test.ts` glob also matches `*.integration.test.ts` filenames,
        // so we MUST exclude integration tests here — they belong to core-integration
        // (which has the container globalSetup). Without this, createTestDb() runs with
        // no `adminUri` and beforeAll fails.
        test: {
          name: 'core-unit',
          globals: true,
          environment: 'node',
          include: ['packages/core/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts'],
          restoreMocks: true,
        },
      },
      // ALL NestJS tests run under the package's OWN config, which applies
      // unplugin-swc for decorator metadata. Referencing the config path here
      // (not globbing nestjs files into a plain project) is REQUIRED — otherwise
      // decorator DI silently breaks under the root runner.
      'packages/nestjs',
      // The core-integration project is added in Task 2 (needs the container harness).
    ],
  },
});
```

> **Critical wiring rule (Tasks 1/2/8):** the root `core-*` projects glob **only** `packages/core/**`. NestJS `.test.ts`/`.integration.test.ts` files must be run **exclusively** by the `'packages/nestjs'` project (SWC). Never add `packages/*/...` or `packages/nestjs/...` globs to the core projects.

- [ ] **Step 3: Core package skeleton (tsdown, modern tsconfig)**

Create `packages/core/package.json`:

```json
{
  "name": "@drizzle-tx/core",
  "version": "0.0.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public" },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsdown",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "check:publish": "pnpm build && publint --strict && attw --pack ."
  },
  "peerDependencies": { "drizzle-orm": "^1.0.0-rc.4" },
  "peerDependenciesMeta": { "drizzle-orm": { "optional": true } },
  "devDependencies": {
    "drizzle-orm": "catalog:",
    "pg": "catalog:",
    "@types/pg": "catalog:",
    "tsdown": "0.22.3",
    "publint": "^0.3.21",
    "@arethetypeswrong/cli": "^0.18.4",
    "typescript": "catalog:"
  }
}
```

> `drizzle-orm` is an **optional peer** on core because the pure engine/types don't import it at the top level; `drizzle-adapter.ts` uses only structural types. This keeps `@drizzle-tx/core` usable for type-only consumers.

Create `packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "isolatedDeclarations": true,
    "erasableSyntaxOnly": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "**/*.integration.test.ts", "**/*.test-d.ts", "dist"]
}
```

Create `packages/core/tsdown.config.ts`:

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,       // uses tsconfig isolatedDeclarations → fast Oxc emit
  clean: true,
  outDir: 'dist',
  target: 'es2023',
});
```

Create `packages/core/src/index.ts` with `export const version = '0.0.0';` (placeholder; real exports added later).
Create `packages/core/src/smoke.test.ts`:

```ts
import { expect, it } from 'vitest';
import { version } from './index.js';

it('core package is importable', () => {
  expect(version).toBe('0.0.0');
});
```

- [ ] **Step 4: NestJS package skeleton (tsc, decorators) + DI metadata smoke test**

Create `packages/nestjs/package.json`:

```json
{
  "name": "@drizzle-tx/nestjs",
  "version": "0.0.0",
  "type": "commonjs",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "rimraf dist && tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "check:publish": "pnpm build && publint --strict && attw --pack ."
  },
  "dependencies": { "@drizzle-tx/core": "workspace:*" },
  "peerDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "drizzle-orm": "^1.0.0-rc.4",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "@nestjs/common": "catalog:",
    "@nestjs/core": "catalog:",
    "@nestjs/testing": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "drizzle-orm": "catalog:",
    "pg": "catalog:",
    "@types/pg": "catalog:",
    "reflect-metadata": "catalog:",
    "rxjs": "catalog:",
    "unplugin-swc": "^1.5.9",
    "@swc/core": "^1.15.43",
    "rimraf": "^6.1.3",
    "publint": "^0.3.21",
    "@arethetypeswrong/cli": "^0.18.4",
    "typescript": "catalog:"
  }
}
```

Create `packages/nestjs/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "node16",
    "moduleResolution": "node16",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "**/*.integration.test.ts", "**/*.test-d.ts", "dist"]
}
```

Create `packages/nestjs/vitest.config.ts`:

```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    name: 'nestjs',
    globals: true,
    environment: 'node',
    restoreMocks: true,
    // No `include` yet → Vitest's default picks up di-smoke.integration.test.ts.
    // Task 8 adds the container globalSetup + forks pool for DB integration tests.
  },
});
```

Create `packages/nestjs/src/index.ts` with `export const version = '0.0.0';`.
Create `packages/nestjs/src/di-smoke.integration.test.ts` (named `.integration` only to keep it out of the fast unit project; it needs no DB):

```ts
import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { expect, it } from 'vitest';

const TOKEN = Symbol('DEP');

@Injectable()
class Dep {
  readonly tag = 'dep';
}

@Injectable()
class Consumer {
  // Constructor param DI relies on emitDecoratorMetadata design:paramtypes.
  constructor(@Inject(Dep) readonly dep: Dep) {}
}

it('emitDecoratorMetadata drives constructor DI (TS6/SWC)', async () => {
  const moduleRef = await Test.createTestingModule({ providers: [Dep, Consumer] }).compile();
  const consumer = moduleRef.get(Consumer);
  expect(consumer.dep).toBeInstanceOf(Dep);
  expect(consumer.dep.tag).toBe('dep');
});
```

- [ ] **Step 5: Install, build, typecheck, lint, and run smoke tests**

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm run test:unit
```

Expected:
- `pnpm build` → both packages emit `dist/` (core has `index.js`, `index.cjs`, `index.d.ts`, `index.d.cts`; nestjs has `index.js`, `index.d.ts`).
- `pnpm typecheck` → PASS, no errors.
- `pnpm lint` → PASS (fix with `pnpm lint:fix` if formatting differs).
- `pnpm run test:unit` → PASS for `core package is importable`.

- [ ] **Step 6: Verify the TS6/decorator metadata risk explicitly**

```bash
pnpm --filter @drizzle-tx/nestjs exec vitest run src/di-smoke.integration.test.ts
```

Expected: PASS for `emitDecoratorMetadata drives constructor DI (TS6/SWC)`. **If this FAILS**, edit `pnpm-workspace.yaml` catalog `typescript: 6.0.3` → `typescript: 5.9.3`, run `pnpm install`, and re-run Steps 5–6. Record which TS version was used in the PR description.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo, toolchain, and smoke tests"
```

---

## Task 2: Real-Postgres integration harness + Drizzle 1.0 rc.4 spike

**Files:**
- Create: `vitest.globalSetup.ts`, `vitest.dbPerWorker.ts`, `test/schema.ts`, `drizzle.config.ts`
- Modify: `vitest.config.ts` (add the `integration` project)
- Create: `packages/core/src/drizzle-spike.integration.test.ts` (validates the ORM API; can be deleted after Task 7 or kept as a smoke)

- [ ] **Step 1: Test schema with relations v2 (validates rc.4 `defineRelations`)**

Create `test/schema.ts`:

```ts
import { defineRelations } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  balance: integer('balance').notNull().default(0),
});

export const schema = { users, accounts };

// relations v2 — validate this exact call shape against installed rc.4 types.
export const relations = defineRelations(schema, (r) => ({
  users: { accounts: r.many.accounts({ from: r.users.id, to: r.accounts.userId }) },
  accounts: { user: r.one.users({ from: r.accounts.userId, to: r.users.id }) },
}));
```

> If `defineRelations` / `r.many` / `r.one` signatures differ in the installed `drizzle-orm@1.0.0-rc.4`, adjust to the real API (check `node_modules/drizzle-orm/relations.d.ts`) and keep the two-table `users`↔`accounts` shape. This is the spike — resolve the API here so later tasks just consume the proxy.

- [ ] **Step 2: Testcontainers globalSetup (container once) + per-worker DB helper**

Create `vitest.globalSetup.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { GlobalSetupContext } from 'vitest/node';

let container: StartedPostgreSqlContainer;

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  // Admin URI used by each worker to CREATE its own database.
  provide('adminUri', container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

declare module 'vitest' {
  interface ProvidedContext {
    adminUri: string;
  }
}
```

Create `vitest.dbPerWorker.ts` — creates a unique DB per worker, migrates the schema by executing DDL (no drizzle-kit needed for these two tables), and returns a Drizzle instance + Pool:

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { inject } from 'vitest';
import { relations, schema } from './test/schema.js';

export interface TestDb {
  db: NodePgDatabase<typeof schema, typeof relations>;
  pool: Pool;
  close: () => Promise<void>;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY,
    name text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id serial PRIMARY KEY,
    user_id integer NOT NULL,
    balance integer NOT NULL DEFAULT 0
  );
`;

/** Create an isolated database for this worker and return a migrated Drizzle instance.
 *  poolMax lets deadlock tests use a tiny pool. */
export async function createTestDb(poolMax = 10): Promise<TestDb> {
  const adminUri = inject('adminUri');
  const workerId = process.env.VITEST_POOL_ID ?? '0';
  const dbName = `test_w${workerId}_${Date.now().toString(36)}`;

  const admin = new Pool({ connectionString: adminUri, max: 1 });
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const workerUri = new URL(adminUri);
  workerUri.pathname = `/${dbName}`;
  const pool = new Pool({
    connectionString: workerUri.toString(),
    max: poolMax,
    connectionTimeoutMillis: 3000, // fail fast (ADR-0002)
  });
  await pool.query(DDL);

  const db = drizzle(pool, { relations });
  return { db, pool, close: () => pool.end() };
}
```

> `Date.now()` is fine in test runtime (not in a workflow script). `relations` is passed to `drizzle()` per rc.4; adjust the generic if the installed types name it differently.

- [ ] **Step 3: Add the CORE integration project to root `vitest.config.ts`**

Replace the `// The core-integration project is added in Task 2` comment with a project that globs **only `packages/core`** (NestJS integration tests run under the `'packages/nestjs'` project — never here):

```ts
      {
        test: {
          name: 'core-integration',
          globals: true,
          environment: 'node',
          include: ['packages/core/src/**/*.integration.test.ts'],
          globalSetup: ['./vitest.globalSetup.ts'],
          pool: 'forks',
          restoreMocks: true,
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
```

> The NestJS decorator integration tests are wired to their own SWC project's container harness in Task 8. Do **not** glob `packages/nestjs/**` into this core project — esbuild would strip decorator metadata and DI would break.

- [ ] **Step 4: Write the spike integration test (validates insert/select + db.query on real PG)**

Create `packages/core/src/drizzle-spike.integration.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../vitest.dbPerWorker.js';
import { accounts, users } from '../../../test/schema.js';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

it('insert + select round-trips on real Postgres', async () => {
  const [u] = await t.db.insert(users).values({ name: 'Ada' }).returning();
  expect(u).toMatchObject({ id: expect.any(Number), name: 'Ada' });

  const found = await t.db.select().from(users).where(eq(users.id, u!.id));
  expect(found).toEqual([{ id: u!.id, name: 'Ada' }]);
});

it('db.query relations v2 loads related rows', async () => {
  const [u] = await t.db.insert(users).values({ name: 'Grace' }).returning();
  await t.db.insert(accounts).values({ userId: u!.id, balance: 100 });

  const withAccounts = await t.db.query.users.findFirst({
    where: { id: u!.id },
    with: { accounts: true },
  });
  expect(withAccounts).toMatchObject({ name: 'Grace', accounts: [{ balance: 100 }] });
});
```

> The `where`/`with` shape is relations v2. If the installed rc.4 differs (e.g. `where: (u, {eq}) => eq(u.id, ...)`), fix it here — this test's job is to lock the real API.

- [ ] **Step 5: Run the integration spike**

```bash
docker info >/dev/null 2>&1 && echo "docker ok"
pnpm run test:int -- packages/core/src/drizzle-spike.integration.test.ts
```

Expected: PASS for both `insert + select round-trips on real Postgres` and `db.query relations v2 loads related rows`. (First run pulls `postgres:17-alpine`.) If Docker is unavailable, start it; do not mock.

- [ ] **Step 6: drizzle-kit config (for consumers/migrations parity) + commit**

Create `drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './test/schema.ts',
  out: './drizzle',
});
```

Add `drizzle-kit` to root devDependencies (`"drizzle-kit": "catalog:"`), `pnpm install`.

```bash
git add -A && git commit -m "test: real-postgres harness (testcontainers, db-per-worker) + drizzle v1 spike"
```

---

## Task 3: Core error model — `Result`, `assertNever`, `DrizzleTxError` (type modeling)

**Files:**
- Create: `packages/core/src/result.ts`, `packages/core/src/errors.ts`, `packages/core/src/result.test.ts`, `packages/core/src/errors.test-d.ts`

- [ ] **Step 1: Write failing tests for `Result` + `assertNever`**

Create `packages/core/src/result.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertNever, err, isErr, isOk, ok, type Result } from './result.js';

describe('Result', () => {
  it('ok wraps a value with ok:true', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });
  it('err wraps an error with ok:false', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });
  it('isOk / isErr narrow correctly', () => {
    const r: Result<number, string> = ok(1);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(1); // type-narrowed access compiles
  });
  it('assertNever throws with the offending value serialized', () => {
    expect(() => assertNever('x' as never)).toThrowError(/Unhandled variant: "x"/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `vitest run packages/core/src/result.test.ts`
Expected: FAIL — cannot resolve `./result.js` (module not created).

- [ ] **Step 3: Implement `result.ts` (explicit types for isolatedDeclarations)**

```ts
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export function assertNever(x: never, message = 'Unhandled variant'): never {
  throw new Error(`${message}: ${JSON.stringify(x)}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `vitest run packages/core/src/result.test.ts`
Expected: PASS for all 4 `Result` tests.

- [ ] **Step 5: Model `DrizzleTxError` + a compile-time exhaustiveness test**

Create `packages/core/src/errors.ts`:

```ts
export type DrizzleTxError =
  | { readonly kind: 'PoolConnectionTimeout'; readonly timeoutMs: number | undefined }
  | { readonly kind: 'TransactionAborted'; readonly cause: unknown }
  | { readonly kind: 'HostNotInitialized'; readonly connectionName: string | undefined }
  | { readonly kind: 'NotPoolBacked' };

export const poolConnectionTimeout = (timeoutMs: number | undefined): DrizzleTxError => ({
  kind: 'PoolConnectionTimeout',
  timeoutMs,
});
export const transactionAborted = (cause: unknown): DrizzleTxError => ({
  kind: 'TransactionAborted',
  cause,
});
export const hostNotInitialized = (connectionName: string | undefined): DrizzleTxError => ({
  kind: 'HostNotInitialized',
  connectionName,
});
export const notPoolBacked = (): DrizzleTxError => ({ kind: 'NotPoolBacked' });
```

Create `packages/core/src/errors.test-d.ts` (checked by `tsc --noEmit`, not Vitest):

```ts
import { assertNever } from './result.js';
import type { DrizzleTxError } from './errors.js';

// If a variant is added without a case here, this fails to compile — proving exhaustiveness.
export function describeError(e: DrizzleTxError): string {
  switch (e.kind) {
    case 'PoolConnectionTimeout':
      return `pool timeout after ${e.timeoutMs}ms`;
    case 'TransactionAborted':
      return 'aborted';
    case 'HostNotInitialized':
      return `host not initialized for ${e.connectionName ?? 'default'}`;
    case 'NotPoolBacked':
      return 'base db is not Pool-backed';
    default:
      return assertNever(e);
  }
}
```

- [ ] **Step 6: Verify types compile (exhaustiveness holds)**

Run: `pnpm --filter @drizzle-tx/core exec tsc --noEmit -p tsconfig.json`
Expected: PASS (no errors). To confirm the guard works, temporarily add a 5th `DrizzleTxError` variant → `tsc` must error at `assertNever(e)`; revert.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/result.ts packages/core/src/result.test.ts packages/core/src/errors.ts packages/core/src/errors.test-d.ts
git commit -m "feat(core): explicit Result + exhaustive DrizzleTxError model"
```

---

## Task 4: `Propagation`, `TxOptions`, adapter seam, logger seam

**Files:**
- Create: `packages/core/src/propagation.ts`, `packages/core/src/options.ts`, `packages/core/src/logger.ts`, `packages/core/src/adapter.ts`, `packages/core/src/propagation.test.ts`, `packages/core/src/logger.test.ts`

- [ ] **Step 1: Write failing tests for `Propagation` + `logger`**

Create `packages/core/src/propagation.test.ts`:

```ts
import { expect, it } from 'vitest';
import { Propagation } from './propagation.js';

it('exposes the three v1 propagation modes as string values', () => {
  expect(Propagation.Required).toBe('REQUIRED');
  expect(Propagation.RequiresNew).toBe('REQUIRES_NEW');
  expect(Propagation.Nested).toBe('NESTED');
  expect(Object.values(Propagation)).toEqual(['REQUIRED', 'REQUIRES_NEW', 'NESTED']);
});
```

Create `packages/core/src/logger.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
import { consoleLogger, noopLogger } from './logger.js';

it('noopLogger.warn does nothing', () => {
  expect(() => noopLogger.warn('x')).not.toThrow();
});

it('consoleLogger.warn prefixes and forwards to console.warn', () => {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  consoleLogger.warn('stripped isolation');
  expect(spy).toHaveBeenCalledWith('[drizzle-tx] stripped isolation');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `vitest run packages/core/src/propagation.test.ts packages/core/src/logger.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the four modules**

`packages/core/src/propagation.ts` (const-object union — no TS `enum`, satisfies `erasableSyntaxOnly`):

```ts
export const Propagation = {
  Required: 'REQUIRED',
  RequiresNew: 'REQUIRES_NEW',
  Nested: 'NESTED',
} as const;

export type Propagation = (typeof Propagation)[keyof typeof Propagation];
```

`packages/core/src/options.ts`:

```ts
export interface TxOptions {
  readonly isolationLevel?:
    | 'read uncommitted'
    | 'read committed'
    | 'repeatable read'
    | 'serializable';
  readonly accessMode?: 'read only' | 'read write';
  readonly deferrable?: boolean;
}
```

`packages/core/src/logger.ts`:

```ts
export interface TxLogger {
  warn(message: string): void;
}

export const noopLogger: TxLogger = { warn: () => {} };

export const consoleLogger: TxLogger = {
  warn: (message) => {
    // biome-ignore lint/suspicious/noConsole: intentional library warning seam
    console.warn(`[drizzle-tx] ${message}`);
  },
};
```

`packages/core/src/adapter.ts` — the ORM seam (`getBaseClient` per CONTEXT.md, not "fallback instance"):

```ts
import type { TxOptions } from './options.js';

export interface TransactionAdapter<TClient> {
  /** The pool-backed base client (used outside a transaction and to start new top-level ones). */
  getBaseClient(): TClient;

  /** True if the adapter can start an independent concurrent top-level transaction
   *  (i.e. Pool-backed). REQUIRES_NEW while already active requires this. */
  readonly supportsIndependentTransactions: boolean;

  /** Start a new top-level transaction from the base client; call setClient with the tx client. */
  wrapWithTransaction<T>(
    options: TxOptions | undefined,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T>;

  /** Start a savepoint from the given parent transaction client. */
  wrapWithNestedTransaction<T>(
    parent: TClient,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T>;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `vitest run packages/core/src/propagation.test.ts packages/core/src/logger.test.ts`
Expected: PASS for all propagation + logger tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/propagation.ts packages/core/src/options.ts packages/core/src/logger.ts packages/core/src/adapter.ts packages/core/src/propagation.test.ts packages/core/src/logger.test.ts
git commit -m "feat(core): propagation, tx options, adapter seam, logger seam"
```

---

## Task 5: `TransactionManager` engine (ALS + propagation switch + rollback-via-err)

**Depends on Tasks 3, 4.** This is the heart of the engine and is fully unit-testable with a **fake adapter** (no DB).

**Files:**
- Create: `packages/core/src/transaction-manager.ts`, `packages/core/src/transaction-manager.test.ts`

- [ ] **Step 1: Write failing unit tests with a fake adapter**

Create `packages/core/src/transaction-manager.test.ts`. The fake adapter records lifecycle and lets us assert propagation decisions without a database:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TransactionAdapter } from './adapter.js';
import { err, ok, type Result } from './result.js';
import { Propagation } from './propagation.js';
import { TransactionManager } from './transaction-manager.js';

/** Fake client is just a tagged object; a new tag per BEGIN so we can assert identity. */
type FakeClient = { readonly tag: string };

function makeFakeAdapter(opts?: { supportsIndependent?: boolean }): {
  adapter: TransactionAdapter<FakeClient>;
  begins: string[];
  savepoints: string[];
} {
  const base: FakeClient = { tag: 'base' };
  const begins: string[] = [];
  const savepoints: string[] = [];
  let counter = 0;
  const adapter: TransactionAdapter<FakeClient> = {
    getBaseClient: () => base,
    supportsIndependentTransactions: opts?.supportsIndependent ?? true,
    wrapWithTransaction: async (_options, setClient, work) => {
      const tx: FakeClient = { tag: `tx${++counter}` };
      begins.push(tx.tag);
      setClient(tx);
      return work(); // throwing here == rollback (drizzle semantics)
    },
    wrapWithNestedTransaction: async (_parent, setClient, work) => {
      const sp: FakeClient = { tag: `sp${++counter}` };
      savepoints.push(sp.tag);
      setClient(sp);
      return work();
    },
  };
  return { adapter, begins, savepoints };
}

describe('TransactionManager', () => {
  it('getTransactionClient returns base client outside a transaction', () => {
    const { adapter } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    expect(m.getTransactionClient().tag).toBe('base');
    expect(m.isTransactionActive()).toBe(false);
  });

  it('REQUIRED starts a transaction and exposes the tx client to work', async () => {
    const { adapter, begins } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const result = await m.withTransaction(async () => {
      expect(m.isTransactionActive()).toBe(true);
      return ok(m.getTransactionClient().tag);
    });
    expect(result).toEqual({ ok: true, value: 'tx1' });
    expect(begins).toEqual(['tx1']);
  });

  it('REQUIRED returns err when work returns err (rollback path)', async () => {
    const { adapter } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const result = await m.withTransaction(async () => err('DOMAIN_FAIL' as const));
    expect(result).toEqual({ ok: false, error: 'DOMAIN_FAIL' });
  });

  it('wraps an unexpected throw as TransactionAborted (never rethrows)', async () => {
    const { adapter } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    const boom = new Error('kaboom');
    const result = await m.withTransaction(async () => {
      throw boom;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'TransactionAborted', cause: boom });
    }
  });

  it('REQUIRED joins an existing transaction (no second BEGIN)', async () => {
    const { adapter, begins } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    await m.withTransaction(async () => {
      const outerTag = m.getTransactionClient().tag;
      const inner = await m.withTransaction(Propagation.Required, async () => ok(m.getTransactionClient().tag));
      expect(inner).toEqual({ ok: true, value: outerTag }); // same client
      return ok(null);
    });
    expect(begins).toEqual(['tx1']); // only one BEGIN
  });

  it('REQUIRES_NEW starts an independent transaction even when active', async () => {
    const { adapter, begins } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    await m.withTransaction(async () => {
      await m.withTransaction(Propagation.RequiresNew, async () => ok(null));
      return ok(null);
    });
    expect(begins).toEqual(['tx1', 'tx2']); // two independent BEGINs
  });

  it('REQUIRES_NEW while active returns err(NotPoolBacked) when adapter cannot', async () => {
    const { adapter } = makeFakeAdapter({ supportsIndependent: false });
    const m = new TransactionManager(adapter);
    // The outer work must WRAP the inner result in ok(), otherwise returning the
    // inner err directly would roll the OUTER back (err is the rollback signal).
    const result = await m.withTransaction(async () => {
      const inner = await m.withTransaction(Propagation.RequiresNew, async () => ok('inner'));
      return ok(inner);
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ ok: false, error: { kind: 'NotPoolBacked' } });
  });

  it('NESTED uses a savepoint when active', async () => {
    const { adapter, savepoints } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    await m.withTransaction(async () => {
      await m.withTransaction(Propagation.Nested, async () => ok(m.getTransactionClient().tag));
      return ok(null);
    });
    expect(savepoints).toEqual(['sp2']);
  });

  it('NESTED with no active transaction starts a top-level one', async () => {
    const { adapter, begins, savepoints } = makeFakeAdapter();
    const m = new TransactionManager(adapter);
    await m.withTransaction(Propagation.Nested, async () => ok(null));
    expect(begins).toEqual(['tx1']);
    expect(savepoints).toEqual([]);
  });

  it('warns and strips tx options when joining REQUIRED / NESTED', async () => {
    const { adapter } = makeFakeAdapter();
    const warn = vi.fn();
    const m = new TransactionManager(adapter, { logger: { warn } });
    await m.withTransaction(async () => {
      await m.withTransaction(Propagation.Nested, { isolationLevel: 'serializable' }, async () => ok(null));
      return ok(null);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `vitest run packages/core/src/transaction-manager.test.ts`
Expected: FAIL — `./transaction-manager.js` not found.

- [ ] **Step 3: Implement `transaction-manager.ts`**

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionAdapter } from './adapter.js';
import { type DrizzleTxError, notPoolBacked, transactionAborted } from './errors.js';
import { consoleLogger, type TxLogger } from './logger.js';
import type { TxOptions } from './options.js';
import { Propagation } from './propagation.js';
import { err, ok, type Result } from './result.js';

interface TxContext<TClient> {
  client: TClient;
  active: boolean;
}

/** Internal throw used ONLY to trigger a rollback; caught at the same boundary. */
class RollbackSignal<E> {
  constructor(readonly payload: E) {}
}

type Work<T, E> = () => Promise<Result<T, E>>;

export interface TransactionManagerOptions {
  readonly logger?: TxLogger;
}

export class TransactionManager<TClient> {
  readonly #als = new AsyncLocalStorage<TxContext<TClient>>();
  readonly #adapter: TransactionAdapter<TClient>;
  readonly #logger: TxLogger;

  constructor(adapter: TransactionAdapter<TClient>, options?: TransactionManagerOptions) {
    this.#adapter = adapter;
    this.#logger = options?.logger ?? consoleLogger;
  }

  getTransactionClient(): TClient {
    return this.#als.getStore()?.client ?? this.#adapter.getBaseClient();
  }

  isTransactionActive(): boolean {
    return this.#als.getStore()?.active ?? false;
  }

  // Overloads mirror the imperative API.
  withTransaction<T, E>(work: Work<T, E>): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(propagation: Propagation, work: Work<T, E>): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(options: TxOptions, work: Work<T, E>): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    propagation: Propagation,
    options: TxOptions,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>>;
  withTransaction<T, E>(
    a: Propagation | TxOptions | Work<T, E>,
    b?: TxOptions | Work<T, E>,
    c?: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    let propagation: Propagation = Propagation.Required;
    let options: TxOptions | undefined;
    let work: Work<T, E>;
    if (typeof a === 'function') {
      work = a;
    } else if (typeof a === 'string') {
      propagation = a;
      if (typeof b === 'function') work = b;
      else {
        options = b as TxOptions;
        work = c as Work<T, E>;
      }
    } else {
      options = a;
      work = b as Work<T, E>;
    }
    return this.#run(propagation, options, work);
  }

  #run<T, E>(
    propagation: Propagation,
    options: TxOptions | undefined,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    const active = this.isTransactionActive();
    switch (propagation) {
      case Propagation.Required:
        return active ? this.#join(options, work) : this.#newTransaction(options, work);
      case Propagation.RequiresNew:
        if (active && !this.#adapter.supportsIndependentTransactions) {
          return Promise.resolve(err(notPoolBacked()));
        }
        return this.#newTransaction(options, work);
      case Propagation.Nested:
        return active ? this.#nested(options, work) : this.#newTransaction(options, work);
      default:
        // v1 supports only the three modes above; the type prevents others.
        return this.#newTransaction(options, work);
    }
  }

  /** Join: run work in the current context; no new BEGIN. Options are ignored (warn). */
  async #join<T, E>(options: TxOptions | undefined, work: Work<T, E>): Promise<Result<T, E | DrizzleTxError>> {
    this.#warnIfOptions(options, 'joining an existing transaction');
    return work();
  }

  async #newTransaction<T, E>(
    options: TxOptions | undefined,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    const ctx: TxContext<TClient> = { client: this.#adapter.getBaseClient(), active: true };
    try {
      const value = await this.#als.run(ctx, () =>
        this.#adapter.wrapWithTransaction(
          options,
          (client) => {
            ctx.client = client;
          },
          async () => this.#execute(work),
        ),
      );
      return ok(value);
    } catch (e) {
      return this.#fromThrow<T, E>(e);
    }
  }

  async #nested<T, E>(
    options: TxOptions | undefined,
    work: Work<T, E>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    this.#warnIfOptions(options, 'a NESTED (savepoint) transaction');
    const parent = this.getTransactionClient();
    const ctx: TxContext<TClient> = { client: parent, active: true };
    try {
      const value = await this.#als.run(ctx, () =>
        this.#adapter.wrapWithNestedTransaction(
          parent,
          (client) => {
            ctx.client = client;
          },
          async () => this.#execute(work),
        ),
      );
      return ok(value);
    } catch (e) {
      return this.#fromThrow<T, E>(e);
    }
  }

  /** Run work; convert an `err` result into the rollback-triggering throw. */
  async #execute<T, E>(work: Work<T, E>): Promise<T> {
    const result = await work();
    if (!result.ok) throw new RollbackSignal(result.error);
    return result.value;
  }

  #fromThrow<T, E>(e: unknown): Result<T, E | DrizzleTxError> {
    if (e instanceof RollbackSignal) return err(e.payload as E);
    return err(transactionAborted(e));
  }

  #warnIfOptions(options: TxOptions | undefined, context: string): void {
    if (options && Object.keys(options).length > 0) {
      this.#logger.warn(
        `Transaction options are ignored for ${context}; isolation/access-mode apply only to a new top-level transaction.`,
      );
    }
  }
}
```

> **Design notes for the reviewer:** `err` is the rollback signal (ADR-0003). A join returns `work()` directly — an inner `err` rolls back only if it propagates to the outermost `#newTransaction` (explicit Result propagation, a deliberate difference from Spring's rollback-only flag; documented in the README). `PoolConnectionTimeout` mapping happens in the Drizzle adapter (Task 6), surfacing here via `#fromThrow` only if the adapter rethrows a typed marker — but for the fail-fast path the adapter maps it to a `RollbackSignal`-like typed error; see Task 7.

- [ ] **Step 4: Run to verify pass**

Run: `vitest run packages/core/src/transaction-manager.test.ts`
Expected: PASS for all `TransactionManager` tests (10 cases).

- [ ] **Step 5: Refactor + typecheck**

Run: `pnpm --filter @drizzle-tx/core exec tsc --noEmit -p tsconfig.json`
Expected: PASS. Fix any `isolatedDeclarations` complaints by adding explicit return types.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transaction-manager.ts packages/core/src/transaction-manager.test.ts
git commit -m "feat(core): AsyncLocalStorage transaction manager with REQUIRED/REQUIRES_NEW/NESTED"
```

---

## Task 6: `DrizzleAdapter` (async pg) + real-DB commit/rollback/isolation

**Depends on Tasks 2, 5.**

**Files:**
- Create: `packages/core/src/drizzle-adapter.ts`, `packages/core/src/drizzle-adapter.integration.test.ts`

- [ ] **Step 1: Write failing integration tests (real Postgres)**

Create `packages/core/src/drizzle-adapter.integration.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '../../../vitest.dbPerWorker.js';
import { users } from '../../../test/schema.js';
import { DrizzleAdapter } from './drizzle-adapter.js';
import { ok } from './result.js';
import { TransactionManager } from './transaction-manager.js';

let t: TestDb;
let manager: TransactionManager<any>;

beforeAll(async () => {
  t = await createTestDb();
  manager = new TransactionManager(new DrizzleAdapter({ db: t.db }), { logger: { warn: () => {} } });
});
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pool.query('TRUNCATE users RESTART IDENTITY CASCADE'); });

it('commits: row is visible on a SEPARATE connection after success', async () => {
  const result = await manager.withTransaction(async () => {
    const client = manager.getTransactionClient();
    const [u] = await client.insert(users).values({ name: 'Committed' }).returning();
    return ok(u);
  });
  expect(result.ok).toBe(true);

  const other = new Pool({ connectionString: t.pool.options.connectionString });
  const seen = await other.query('SELECT name FROM users WHERE name = $1', ['Committed']);
  await other.end();
  expect(seen.rowCount).toBe(1);
});

it('rolls back: row is ABSENT after work returns err', async () => {
  const result = await manager.withTransaction(async () => {
    const client = manager.getTransactionClient();
    await client.insert(users).values({ name: 'RolledBack' });
    return { ok: false as const, error: 'nope' as const };
  });
  expect(result).toEqual({ ok: false, error: 'nope' });

  const rows = await t.pool.query('SELECT * FROM users WHERE name = $1', ['RolledBack']);
  expect(rows.rowCount).toBe(0);
});

it('isolation: base client cannot see uncommitted rows written inside the tx', async () => {
  await manager.withTransaction(async () => {
    const txClient = manager.getTransactionClient();
    await txClient.insert(users).values({ name: 'Uncommitted' });
    // Read via the BASE client (separate connection) — must not see it.
    const viaBase = await t.db.select().from(users).where(eq(users.name, 'Uncommitted'));
    expect(viaBase).toEqual([]);
    return ok(null);
  });
});

it('forwards isolationLevel to Drizzle on a NEW top-level transaction', async () => {
  const spy = vi.spyOn(t.db, 'transaction');
  const result = await manager.withTransaction({ isolationLevel: 'serializable' }, async () => {
    await manager.getTransactionClient().insert(users).values({ name: 'Serial' });
    return ok(null);
  });
  expect(result.ok).toBe(true);
  // The option must reach db.transaction(cb, { isolationLevel: 'serializable' }).
  expect(spy).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'serializable' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm run test:int -- packages/core/src/drizzle-adapter.integration.test.ts`
Expected: FAIL — `./drizzle-adapter.js` not found.

- [ ] **Step 3: Implement `drizzle-adapter.ts`**

```ts
import { Pool } from 'pg';
import type { TransactionAdapter } from './adapter.js';
import type { TxOptions } from './options.js';

/** Minimal structural type for a Drizzle client that can open transactions.
 *  Avoids a hard dependency on drizzle-orm's concrete types. */
export interface DrizzleTxCapable {
  transaction: <T>(fn: (tx: this) => Promise<T>, config?: TxOptions) => Promise<T>;
  $client?: unknown;
}

export interface DrizzleAdapterConfig<TClient extends DrizzleTxCapable> {
  readonly db: TClient;
}

export class DrizzleAdapter<TClient extends DrizzleTxCapable> implements TransactionAdapter<TClient> {
  readonly #db: TClient;
  readonly supportsIndependentTransactions: boolean;

  constructor(config: DrizzleAdapterConfig<TClient>) {
    this.#db = config.db;
    this.supportsIndependentTransactions = config.db.$client instanceof Pool;
  }

  getBaseClient(): TClient {
    return this.#db;
  }

  wrapWithTransaction<T>(
    options: TxOptions | undefined,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.#db.transaction(async (tx) => {
      setClient(tx);
      return work();
    }, options);
  }

  wrapWithNestedTransaction<T>(
    parent: TClient,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T> {
    // Nested == SAVEPOINT; no options (isolation is fixed at the outer tx).
    return parent.transaction(async (sp) => {
      setClient(sp);
      return work();
    });
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm run test:int -- packages/core/src/drizzle-adapter.integration.test.ts`
Expected: PASS for `commits: …`, `rolls back: …`, `isolation: …`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/drizzle-adapter.ts packages/core/src/drizzle-adapter.integration.test.ts
git commit -m "feat(core): async pg DrizzleAdapter with real commit/rollback/isolation tests"
```

---

## Task 7: `createTransactionalClient` proxy + REQUIRES_NEW / NESTED / pool-deadlock behavior

**Depends on Task 6.**

**Files:**
- Create: `packages/core/src/transactional-client.ts`, `packages/core/src/transactional-client.test.ts` (unit), `packages/core/src/propagation.integration.test.ts` (real DB)

- [ ] **Step 1: Unit test the proxy resolution (no DB, fake manager)**

Create `packages/core/src/transactional-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTransactionalClient } from './transactional-client.js';

describe('createTransactionalClient', () => {
  it('reads properties off the currently-active client (not a proxy receiver)', () => {
    // A class with a PRIVATE field accessed via a getter — mirrors Drizzle's shape.
    class Client {
      #secret: string;
      constructor(secret: string) {
        this.#secret = secret;
      }
      get value(): string {
        return this.#secret; // throws if `this` is a foreign object (the proxy)
      }
      echo(x: string): string {
        return `${this.#secret}:${x}`;
      }
    }
    let active = new Client('base');
    const proxy = createTransactionalClient<Client>(() => active);

    expect(proxy.value).toBe('base'); // getter must run on the real instance
    expect(proxy.echo('a')).toBe('base:a'); // method bound to real instance

    active = new Client('tx');
    expect(proxy.value).toBe('tx'); // resolves live, per access
    expect(proxy.echo('b')).toBe('tx:b');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `vitest run packages/core/src/transactional-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `transactional-client.ts` (read off real client — ADR guard Q5)**

```ts
export function createTransactionalClient<TClient extends object>(
  resolve: () => TClient,
): TClient {
  return new Proxy(Object.create(null) as TClient, {
    get(_target, prop) {
      const active = resolve();
      const value = (active as Record<PropertyKey, unknown>)[prop as PropertyKey];
      // Bind functions to the REAL client so private-field access works.
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(active) : value;
    },
    has(_target, prop) {
      return prop in (resolve() as object);
    },
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `vitest run packages/core/src/transactional-client.test.ts`
Expected: PASS for `reads properties off the currently-active client`.

- [ ] **Step 5: Write real-DB propagation + proxy-transparency + deadlock tests**

Create `packages/core/src/propagation.integration.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../vitest.dbPerWorker.js';
import { accounts, users } from '../../../test/schema.js';
import { DrizzleAdapter } from './drizzle-adapter.js';
import { Propagation } from './propagation.js';
import { err, ok } from './result.js';
import { TransactionManager } from './transaction-manager.js';
import { createTransactionalClient } from './transactional-client.js';

let t: TestDb;
let manager: TransactionManager<any>;
let db: any; // the transactional client (proxy)

beforeAll(async () => {
  t = await createTestDb();
  manager = new TransactionManager(new DrizzleAdapter({ db: t.db }), { logger: { warn: () => {} } });
  db = createTransactionalClient(() => manager.getTransactionClient());
});
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pool.query('TRUNCATE users, accounts RESTART IDENTITY CASCADE'); });

it('proxy auto-joins the tx for the query builder AND db.query relations', async () => {
  await manager.withTransaction(async () => {
    const [u] = await db.insert(users).values({ name: 'Ada' }).returning();
    await db.insert(accounts).values({ userId: u.id, balance: 50 });
    const loaded = await db.query.users.findFirst({ where: { id: u.id }, with: { accounts: true } });
    expect(loaded).toMatchObject({ name: 'Ada', accounts: [{ balance: 50 }] });
    return ok(null);
  });
  // committed & visible outside the tx via the same proxy (now hitting base client)
  const all = await db.select().from(users);
  expect(all).toHaveLength(1);
});

it('REQUIRES_NEW inner COMMITS even when the outer rolls back', async () => {
  const outer = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'OuterUser' });
    await manager.withTransaction(Propagation.RequiresNew, async () => {
      await db.insert(users).values({ name: 'AuditUser' }); // independent connection
      return ok(null);
    });
    return err('outer-fails' as const); // rolls the OUTER back
  });
  expect(outer).toEqual({ ok: false, error: 'outer-fails' });

  const rows = await t.pool.query('SELECT name FROM users ORDER BY name');
  expect(rows.rows).toEqual([{ name: 'AuditUser' }]); // OuterUser gone, AuditUser survived
});

it('NESTED rolls back to its savepoint; the outer transaction still commits', async () => {
  const result = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'Keep' });
    await manager.withTransaction(Propagation.Nested, async () => {
      await db.insert(users).values({ name: 'Drop' });
      return err('inner-fails' as const); // rolls back only the savepoint
    });
    return ok(null); // outer commits
  });
  expect(result.ok).toBe(true);

  const rows = await t.pool.query('SELECT name FROM users ORDER BY name');
  expect(rows.rows).toEqual([{ name: 'Keep' }]);
});

it('REQUIRED join: a propagated inner err rolls back the whole transaction', async () => {
  const result = await manager.withTransaction(async () => {
    await db.insert(users).values({ name: 'Outer' });
    // Inner REQUIRED joins the SAME transaction (no new BEGIN).
    const inner = await manager.withTransaction(Propagation.Required, async () => {
      await db.insert(users).values({ name: 'Inner' });
      return err('inner-fails' as const);
    });
    // Propagate the inner err → the outermost boundary throws → full rollback.
    return inner.ok ? ok(null) : inner;
  });
  expect(result).toEqual({ ok: false, error: 'inner-fails' });

  const rows = await t.pool.query('SELECT count(*)::int AS n FROM users');
  expect(rows.rows[0].n).toBe(0); // both Outer and Inner rolled back
});

it('pool exhaustion via REQUIRES_NEW FAILS FAST (does not hang)', async () => {
  // max:1 pool → the outer tx holds the only connection; REQUIRES_NEW cannot get one.
  const small = await createTestDb(1);
  const m = new TransactionManager(new DrizzleAdapter({ db: small.db }), { logger: { warn: () => {} } });
  try {
    const result = await m.withTransaction(async () => {
      // Wrap the inner result so the OUTER commits and surfaces the inner Result.
      const inner = await m.withTransaction(Propagation.RequiresNew, async () => ok('never'));
      return ok(inner);
    });
    // Must resolve (not hang) with an error, well under the pool's 3s connectionTimeout.
    expect(result.ok).toBe(true);
    if (result.ok) {
      const inner = result.value as { ok: boolean; error?: { kind: string } };
      expect(inner.ok).toBe(false);
      expect(['PoolConnectionTimeout', 'TransactionAborted']).toContain(inner.error?.kind);
    }
  } finally {
    await small.close();
  }
}, 10000);
```

- [ ] **Step 6: Make the deadlock test pass — map pg pool timeouts to `PoolConnectionTimeout`**

Update `DrizzleAdapter.wrapWithTransaction` to translate a pg connection-timeout into a typed error the manager maps. Add to `drizzle-adapter.ts`:

```ts
// add near the top
export class PoolTimeoutError {
  constructor(readonly timeoutMs: number | undefined) {}
}
```

Wrap the transaction start:

```ts
  wrapWithTransaction<T>(
    options: TxOptions | undefined,
    setClient: (client: TClient) => void,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.#db
      .transaction(async (tx) => {
        setClient(tx);
        return work();
      }, options)
      .catch((e: unknown) => {
        if (e instanceof Error && /timeout exceeded when trying to connect/i.test(e.message)) {
          throw new PoolTimeoutError(undefined);
        }
        throw e;
      });
  }
```

And in `transaction-manager.ts` `#fromThrow`, map it:

```ts
  #fromThrow<T, E>(e: unknown): Result<T, E | DrizzleTxError> {
    if (e instanceof RollbackSignal) return err(e.payload as E);
    if (e && typeof e === 'object' && 'constructor' in e && (e as { constructor: { name?: string } }).constructor?.name === 'PoolTimeoutError') {
      return err(poolConnectionTimeout((e as { timeoutMs?: number }).timeoutMs));
    }
    return err(transactionAborted(e));
  }
```

> The `constructor.name` check avoids a core→adapter import cycle (core must not import pg). Import `poolConnectionTimeout` from `./errors.js`. If a cleaner seam is preferred, have the adapter interface expose a `classifyError(e): DrizzleTxError | undefined` hook — acceptable refactor, keep the test green.

- [ ] **Step 7: Run the real-DB suite**

Run: `pnpm run test:int -- packages/core/src/propagation.integration.test.ts`
Expected: PASS for all five: proxy auto-join (builder + `db.query`), REQUIRES_NEW independence, NESTED partial rollback, REQUIRED-join propagated rollback, and pool fail-fast.

- [ ] **Step 8: Wire core public exports + build + commit**

Update `packages/core/src/index.ts`:

```ts
export * from './result.js';
export * from './errors.js';
export * from './propagation.js';
export * from './options.js';
export * from './logger.js';
export * from './adapter.js';
export { TransactionManager, type TransactionManagerOptions } from './transaction-manager.js';
export { DrizzleAdapter, type DrizzleAdapterConfig, type DrizzleTxCapable } from './drizzle-adapter.js';
export { createTransactionalClient } from './transactional-client.js';
```

```bash
pnpm --filter @drizzle-tx/core build
git add packages/core
git commit -m "feat(core): tx-aware proxy + REQUIRES_NEW/NESTED/pool-deadlock real-db tests"
```

---

## Task 8: NestJS module + `TransactionHost` + tokens + inject helpers

**Depends on Tasks 6, 7.**

**Files:**
- Create: `packages/nestjs/src/tokens.ts`, `packages/nestjs/src/transaction-host.ts`, `packages/nestjs/src/inject.ts`, `packages/nestjs/src/drizzle-transaction.module.ts`
- Modify: `packages/nestjs/vitest.config.ts` (add the container globalSetup + forks pool)
- Create: `packages/nestjs/src/module.integration.test.ts`

- [ ] **Step 1: Give the NestJS integration tests the DB harness**

Replace the `test` block in `packages/nestjs/vitest.config.ts` with the DB-enabled version (keep the `swc.vite(...)` plugin from Task 1):

```ts
  test: {
    name: 'nestjs',
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['../../vitest.globalSetup.ts'],
    pool: 'forks',
    testTimeout: 30000,
    hookTimeout: 60000,
    restoreMocks: true,
  },
```

> Do **not** exclude `di-smoke.integration.test.ts` — keeping it in the aggregate run preserves the TS6/decorator-metadata guarantee in CI. It needs no DB; it simply ignores the container the globalSetup starts.

- [ ] **Step 2: Write a failing module integration test (real Nest app + real PG)**

Create `packages/nestjs/src/module.integration.test.ts`:

```ts
import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { err, ok } from '@drizzle-tx/core';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../vitest.dbPerWorker.js';
import { users } from '../../../test/schema.js';
import { DRIZZLE_TX_CLIENT } from './tokens.js';
import { TransactionHost } from './transaction-host.js';
import { DrizzleTransactionModule } from './drizzle-transaction.module.js';

let t: TestDb;

@Injectable()
class UserRepo {
  constructor(@Inject(DRIZZLE_TX_CLIENT) private readonly db: any) {}
  create(name: string) {
    return this.db.insert(users).values({ name }).returning();
  }
}

beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pool.query('TRUNCATE users RESTART IDENTITY CASCADE'); });

async function bootstrap() {
  const moduleRef = await Test.createTestingModule({
    imports: [DrizzleTransactionModule.forRoot({ drizzle: t.db })],
    providers: [UserRepo],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

it('injects a tx-aware client and commits via withTransaction', async () => {
  const app = await bootstrap();
  const host = app.get(TransactionHost);
  const repo = app.get(UserRepo);

  const result = await host.withTransaction(async () => {
    const [u] = await repo.create('Tx');
    return ok(u);
  });
  expect(result.ok).toBe(true);

  const rows = await t.pool.query('SELECT name FROM users');
  expect(rows.rows).toEqual([{ name: 'Tx' }]);
  await app.close();
});

it('rolls back when withTransaction work returns err', async () => {
  const app = await bootstrap();
  const host = app.get(TransactionHost);
  const repo = app.get(UserRepo);

  const result = await host.withTransaction(async () => {
    await repo.create('Ghost');
    return err({ kind: 'HostNotInitialized', connectionName: undefined } as const);
  });
  expect(result.ok).toBe(false);

  const rows = await t.pool.query('SELECT * FROM users');
  expect(rows.rowCount).toBe(0);
  await app.close();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @drizzle-tx/nestjs exec vitest run src/module.integration.test.ts`
Expected: FAIL — `./tokens.js` / `./transaction-host.js` / `./drizzle-transaction.module.js` not found.

- [ ] **Step 4: Implement tokens, host, inject, module**

`packages/nestjs/src/tokens.ts`:

```ts
export const DRIZZLE_TX_CLIENT = Symbol.for('drizzle-tx:client');
export const DRIZZLE_TX_MANAGER = Symbol.for('drizzle-tx:manager');
export const DRIZZLE_BASE_DB = Symbol.for('drizzle-tx:base-db');
```

`packages/nestjs/src/transaction-host.ts` — imperative facade + process-global static registry (ADR-0004):

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type DrizzleTxError,
  type Propagation,
  type Result,
  type TransactionManager,
  type TxOptions,
} from '@drizzle-tx/core';
import { DRIZZLE_TX_MANAGER } from './tokens.js';

const registry = new Map<string, TransactionHost>();
const DEFAULT_KEY = 'default';

@Injectable()
export class TransactionHost {
  readonly #manager: TransactionManager<unknown>;

  constructor(@Inject(DRIZZLE_TX_MANAGER) manager: TransactionManager<unknown>) {
    this.#manager = manager;
    registry.set(DEFAULT_KEY, this);
  }

  static get(connectionName?: string): TransactionHost | undefined {
    return registry.get(connectionName ?? DEFAULT_KEY);
  }

  get tx(): unknown {
    return this.#manager.getTransactionClient();
  }
  isTransactionActive(): boolean {
    return this.#manager.isTransactionActive();
  }

  withTransaction<T, E>(
    a: Propagation | TxOptions | (() => Promise<Result<T, E>>),
    b?: TxOptions | (() => Promise<Result<T, E>>),
    c?: () => Promise<Result<T, E>>,
  ): Promise<Result<T, E | DrizzleTxError>> {
    // Delegate all overloads to the manager.
    return (this.#manager.withTransaction as any)(a, b, c);
  }
}
```

`packages/nestjs/src/inject.ts`:

```ts
import { Inject } from '@nestjs/common';
import { DRIZZLE_TX_CLIENT } from './tokens.js';

export const InjectTransactionalClient = (): ParameterDecorator => Inject(DRIZZLE_TX_CLIENT);
```

`packages/nestjs/src/drizzle-transaction.module.ts`:

```ts
import { type DynamicModule, Global, Module } from '@nestjs/common';
import {
  createTransactionalClient,
  DrizzleAdapter,
  type DrizzleTxCapable,
  TransactionManager,
} from '@drizzle-tx/core';
import { DRIZZLE_BASE_DB, DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER } from './tokens.js';
import { TransactionHost } from './transaction-host.js';

export interface DrizzleTransactionModuleOptions {
  readonly drizzle: DrizzleTxCapable;
}
export interface DrizzleTransactionModuleAsyncOptions {
  readonly imports?: any[];
  readonly inject?: any[];
  readonly useFactory: (...args: any[]) => DrizzleTransactionModuleOptions | Promise<DrizzleTransactionModuleOptions>;
}

@Global()
@Module({})
export class DrizzleTransactionModule {
  static forRoot(options: DrizzleTransactionModuleOptions): DynamicModule {
    return this.#build({ provide: DRIZZLE_BASE_DB, useValue: options.drizzle }, []);
  }

  static forRootAsync(options: DrizzleTransactionModuleAsyncOptions): DynamicModule {
    return this.#build(
      {
        provide: DRIZZLE_BASE_DB,
        useFactory: async (...args: any[]) => (await options.useFactory(...args)).drizzle,
        inject: options.inject ?? [],
      },
      options.imports ?? [],
    );
  }

  static #build(baseDbProvider: any, imports: any[]): DynamicModule {
    return {
      module: DrizzleTransactionModule,
      imports,
      providers: [
        baseDbProvider,
        {
          provide: DRIZZLE_TX_MANAGER,
          inject: [DRIZZLE_BASE_DB],
          useFactory: (db: DrizzleTxCapable) => new TransactionManager(new DrizzleAdapter({ db })),
        },
        {
          provide: DRIZZLE_TX_CLIENT,
          inject: [DRIZZLE_TX_MANAGER],
          useFactory: (m: TransactionManager<object>) => createTransactionalClient(() => m.getTransactionClient()),
        },
        TransactionHost,
      ],
      exports: [DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER, DRIZZLE_BASE_DB, TransactionHost],
    };
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @drizzle-tx/nestjs exec vitest run src/module.integration.test.ts`
Expected: PASS for `injects a tx-aware client and commits via withTransaction` and `rolls back when withTransaction work returns err`.

- [ ] **Step 6: Commit**

```bash
git add packages/nestjs/src/tokens.ts packages/nestjs/src/transaction-host.ts packages/nestjs/src/inject.ts packages/nestjs/src/drizzle-transaction.module.ts packages/nestjs/src/module.integration.test.ts packages/nestjs/vitest.config.ts
git commit -m "feat(nestjs): DrizzleTransactionModule, TransactionHost, tx-aware client injection"
```

---

## Task 9: `@Transactional` decorator (registry lookup, metadata copy, type-leak guard)

**Depends on Task 8.**

**Files:**
- Create: `packages/nestjs/src/transactional.decorator.ts`, `packages/nestjs/src/transactional.integration.test.ts`, `packages/nestjs/src/transactional-host-miss.integration.test.ts`, `packages/nestjs/src/transactional.test-d.ts`
- Modify: `packages/nestjs/src/index.ts`

- [ ] **Step 1: Write the failing decorator integration test (commit, rollback, self-invocation, REQUIRES_NEW, NESTED)**

Create `packages/nestjs/src/transactional.integration.test.ts`:

```ts
import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type DrizzleTxError, err, ok, Propagation, type Result } from '@drizzle-tx/core';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../../../vitest.dbPerWorker.js';
import { users } from '../../../test/schema.js';
import { DRIZZLE_TX_CLIENT } from './tokens.js';
import { Transactional } from './transactional.decorator.js';
import { DrizzleTransactionModule } from './drizzle-transaction.module.js';

let t: TestDb;

@Injectable()
class Repo {
  constructor(@Inject(DRIZZLE_TX_CLIENT) private readonly db: any) {}
  add(name: string) {
    return this.db.insert(users).values({ name }).returning();
  }
}

@Injectable()
class Service {
  constructor(private readonly repo: Repo) {}

  @Transactional()
  async createTwo(a: string, b: string): Promise<Result<number, 'fail' | DrizzleTxError>> {
    await this.repo.add(a);
    await this.repo.add(b);
    return ok(2);
  }

  @Transactional()
  async createThenFail(name: string): Promise<Result<never, 'fail' | DrizzleTxError>> {
    await this.repo.add(name);
    return err('fail');
  }

  @Transactional()
  async outerWithAudit(name: string): Promise<Result<null, 'fail' | DrizzleTxError>> {
    await this.repo.add(name);           // rolled back
    await this.audit(`${name}-audit`);   // self-invocation → REQUIRES_NEW, commits
    return err('fail');
  }

  @Transactional(Propagation.RequiresNew)
  async audit(name: string): Promise<Result<null, DrizzleTxError>> {
    await this.repo.add(name);
    return ok(null);
  }
}

beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await t.pool.query('TRUNCATE users RESTART IDENTITY CASCADE'); });

async function boot() {
  const ref = await Test.createTestingModule({
    imports: [DrizzleTransactionModule.forRoot({ drizzle: t.db })],
    providers: [Repo, Service],
  }).compile();
  await ref.init();
  return ref;
}

it('commits both rows on success', async () => {
  const ref = await boot();
  const r = await ref.get(Service).createTwo('a', 'b');
  expect(r).toEqual({ ok: true, value: 2 });
  expect((await t.pool.query('SELECT count(*) FROM users')).rows[0].count).toBe('2');
  await ref.close();
});

it('rolls back all rows when the method returns err', async () => {
  const ref = await boot();
  const r = await ref.get(Service).createThenFail('x');
  expect(r).toEqual({ ok: false, error: 'fail' });
  expect((await t.pool.query('SELECT count(*) FROM users')).rows[0].count).toBe('0');
  await ref.close();
});

it('self-invocation: REQUIRES_NEW audit survives an outer rollback', async () => {
  const ref = await boot();
  const r = await ref.get(Service).outerWithAudit('main');
  expect(r).toEqual({ ok: false, error: 'fail' });
  const rows = await t.pool.query('SELECT name FROM users');
  expect(rows.rows).toEqual([{ name: 'main-audit' }]); // outer 'main' gone; audit survived
  await ref.close();
});

// NOTE: the HostNotInitialized miss-path is covered by a DEDICATED, ISOLATED file
// (packages/nestjs/src/transactional-host-miss.integration.test.ts) added in Step 1b —
// it must boot NO NestJS module so the process-global registry is empty. Do not add a
// miss-path case here, where prior tests have already registered the default host.
```

- [ ] **Step 1b: Add the isolated HostNotInitialized miss-path test (own file → own process → empty registry)**

Create `packages/nestjs/src/transactional-host-miss.integration.test.ts`:

```ts
import 'reflect-metadata';
import { type DrizzleTxError, ok, type Result } from '@drizzle-tx/core';
import { expect, it } from 'vitest';
import { Transactional } from './transactional.decorator.js';

class Svc {
  @Transactional()
  async doIt(): Promise<Result<number, DrizzleTxError>> {
    return ok(1);
  }
}

it('returns err(HostNotInitialized) when no module initialized the host', async () => {
  // This file boots NO NestJS module. With Vitest `forks` + per-file isolation,
  // the process-global TransactionHost registry is empty here.
  const result = await new Svc().doIt();
  expect(result).toEqual({ ok: false, error: { kind: 'HostNotInitialized', connectionName: undefined } });
});
```

> This relies on Vitest's default per-file process isolation under the `forks` pool (each test file → fresh child process → fresh module registry). Keep this test in its **own file** with no `DrizzleTransactionModule` import that would register a host.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @drizzle-tx/nestjs exec vitest run src/transactional.integration.test.ts`
Expected: FAIL — `./transactional.decorator.js` not found.

- [ ] **Step 3: Implement the decorator (Proxy apply-trap + metadata copy + typed guard)**

`packages/nestjs/src/transactional.decorator.ts`:

```ts
import { type DrizzleTxError, hostNotInitialized, type Propagation, type Result } from '@drizzle-tx/core';
import { TransactionHost } from './transaction-host.js';

type TxMethod<A extends unknown[], T, E> = (...args: A) => Promise<Result<T, E>>;

/** ADR-0005: the decorated method's error union must INCLUDE DrizzleTxError
 *  (E must be a supertype). Encoded as `[DrizzleTxError] extends [E]` — tuple-wrapped
 *  to avoid union distribution. When the constraint fails, the descriptor param
 *  resolves to a branded error type, so the real method descriptor is not assignable
 *  → a compile error at the decoration site. NOTE: this is the DIRECTION of the check
 *  (`DrizzleTxError extends E`), the inverse of a plain `E extends DrizzleTxError` bound. */
type GuardDescriptor<A extends unknown[], T, E> = [DrizzleTxError] extends [E]
  ? TypedPropertyDescriptor<TxMethod<A, T, E>>
  : { readonly __drizzleTxError: 'The method Result error union must include DrizzleTxError'; };

export function Transactional(propagation?: Propagation) {
  return <A extends unknown[], T, E>(
    _target: object,
    propertyKey: string | symbol,
    descriptor: GuardDescriptor<A, T, E>,
  ): void => {
    const d = descriptor as TypedPropertyDescriptor<TxMethod<A, T, E>>;
    const original = d.value;
    if (typeof original !== 'function') {
      throw new Error(`@Transactional can only decorate methods; ${String(propertyKey)} is not a function.`);
    }

    d.value = new Proxy(original, {
      apply(target, thisArg, args: A) {
        const host = TransactionHost.get();
        if (!host) {
          return Promise.resolve({ ok: false as const, error: hostNotInitialized(undefined) });
        }
        const bound = (): Promise<Result<T, E>> =>
          Reflect.apply(target, thisArg, args) as Promise<Result<T, E>>;
        return propagation ? host.withTransaction(propagation, bound) : host.withTransaction(bound);
      },
    }) as TxMethod<A, T, E>;

    // Preserve metadata NestJS may have attached (guards, interceptors, etc.).
    for (const key of Reflect.getMetadataKeys(original)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, original), d.value as object);
    }
    // Legacy method decorators mutate the descriptor in place; return void.
  };
}
```

> **Verification & fallback (ADR-0005 Assumption).** The open risk is whether TS *infers* `A`/`T`/`E` through the conditional-typed `descriptor` parameter under `experimentalDecorators`. Step 5's type test is the gate. Two failure signatures and their fallback:
> - If inference fails, `E` widens to `unknown`, `[DrizzleTxError] extends [unknown]` is always true, so the guard never rejects — the `Bad` case compiles and `tsc` reports **"Unused '@ts-expect-error'"**.
> - If inference over-narrows, even the `Good` case fails to compile.
>
> In **either** failure case, apply the fallback: drop the `GuardDescriptor` conditional (use a plain `TypedPropertyDescriptor<TxMethod<A, T, E>>` param), keep the runtime behavior, make `withTransaction()` the blessed type-safe path, ship the decorator with a documented "your method's error union must include `DrizzleTxError`" rule, and record the outcome in the PR. The decorator still ships either way.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @drizzle-tx/nestjs exec vitest run src/transactional.integration.test.ts src/transactional-host-miss.integration.test.ts`
Expected: PASS for commit, rollback, and self-invocation cases, and for `returns err(HostNotInitialized) when no module initialized the host`.

- [ ] **Step 5: Add the type-level guard test**

Create `packages/nestjs/src/transactional.test-d.ts`:

```ts
import type { DrizzleTxError, Result } from '@drizzle-tx/core';
import { Transactional } from './transactional.decorator.js';

// GOOD: error union includes DrizzleTxError → compiles.
class Good {
  @Transactional()
  async ok(): Promise<Result<number, 'domain' | DrizzleTxError>> {
    return { ok: true, value: 1 };
  }
}

// BAD: error union omits DrizzleTxError → must be a compile error.
class Bad {
  // @ts-expect-error — method error union must include DrizzleTxError
  @Transactional()
  async nope(): Promise<Result<number, 'domain'>> {
    return { ok: true, value: 1 };
  }
}

export { Good, Bad };
```

Run: `pnpm --filter @drizzle-tx/nestjs exec tsc --noEmit -p tsconfig.json`
Expected: PASS. The `@ts-expect-error` must be *consumed* (i.e. there IS an error there). If there is NO error (constraint not enforced), `tsc` reports "Unused '@ts-expect-error'" → triggers the Assumption fallback: remove `@ts-expect-error`, document the convention, and keep a lint note.

- [ ] **Step 6: Export + build + commit**

Update `packages/nestjs/src/index.ts`:

```ts
export { DrizzleTransactionModule } from './drizzle-transaction.module.js';
export type {
  DrizzleTransactionModuleOptions,
  DrizzleTransactionModuleAsyncOptions,
} from './drizzle-transaction.module.js';
export { TransactionHost } from './transaction-host.js';
export { Transactional } from './transactional.decorator.js';
export { InjectTransactionalClient } from './inject.js';
export { DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER, DRIZZLE_BASE_DB } from './tokens.js';
// Re-export the Result/propagation surface so consumers import from one place.
export { Propagation, ok, err, isOk, isErr, assertNever } from '@drizzle-tx/core';
export type { Result, DrizzleTxError, TxOptions } from '@drizzle-tx/core';
```

```bash
pnpm --filter @drizzle-tx/nestjs build
git add packages/nestjs
git commit -m "feat(nestjs): @Transactional decorator with type-enforced DrizzleTxError guard"
```

---

## Task 10: Packaging validation + docs + changesets

**Depends on all prior tasks.**

**Files:**
- Create: `README.md`, `packages/core/README.md`, `packages/nestjs/README.md`, `CLAUDE.md`, `LICENSE`, `.changeset/config.json`
- Create: `packages/nestjs/src/consume-core-cjs.integration.test.ts` (proves CJS-requires-core works)

- [ ] **Step 1: Validate publish shape for both packages**

```bash
pnpm -r run check:publish
```

Expected: `publint --strict` reports no problems for both packages; `attw --pack` shows no blocking errors (core resolves in ESM + CJS; nestjs CJS-only note is acceptable). Fix any `exports`/types-ordering issues `publint` reports.

- [ ] **Step 2: Prove the CJS Nest package consumes the dual-format core**

Create `packages/nestjs/src/consume-core-cjs.integration.test.ts`:

```ts
import { expect, it } from 'vitest';

it('resolves @drizzle-tx/core from a CJS context', async () => {
  // The nestjs package is CJS; ensure require-resolution of the core CJS build works.
  const core = await import('@drizzle-tx/core');
  expect(typeof core.ok).toBe('function');
  expect(core.Propagation.Required).toBe('REQUIRED');
});
```

Run: `pnpm --filter @drizzle-tx/nestjs exec vitest run src/consume-core-cjs.integration.test.ts`
Expected: PASS for `resolves @drizzle-tx/core from a CJS context`.

- [ ] **Step 3: Write docs (no placeholders)**

- `README.md`: quick start (module `forRoot`, inject `DRIZZLE_TX_CLIENT`, `@Transactional`), the **propagation table** (REQUIRED/REQUIRES_NEW/NESTED), a **controller example** showing exhaustive `err`→`HttpException` mapping, and a **Limitations** section: Pool-backed requirement + pool-sizing/deadlock (ADR-0002), never-throw model (ADR-0003), self-invocation-works note, v1 out-of-scope list.
- `packages/core/README.md`, `packages/nestjs/README.md`: package-scoped usage.
- `CLAUDE.md`: architecture map (packages + responsibilities), commands (`pnpm build/test/test:int/lint/typecheck/check:publish`), conventions (explicit Result, never throw, `getBaseClient` naming per `CONTEXT.md`, tsc/CJS for nestjs vs tsdown/dual for core, **never add a runtime dependency on nestjs-cls**), and the ALS/propagation gotchas.
- `LICENSE`: MIT, author from `git config user.name`.

- [ ] **Step 4: Changesets**

```bash
pnpm changeset init
```

Edit `.changeset/config.json`: `"access": "public"`, `"baseBranch": "main"`. Create an initial changeset:

```bash
pnpm changeset  # choose both packages, minor, summary "initial v0.1.0"
```

- [ ] **Step 5: Full green gate + commit**

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

Expected: all PASS (unit + integration). Then:

```bash
git add -A
git commit -m "docs: READMEs, CLAUDE.md, LICENSE; chore: changesets + publish validation"
```

---

## Task 11: CI + release workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: CI workflow (Node 20/22/24 matrix, Docker for Testcontainers)**

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: {}
jobs:
  build-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test           # Docker preinstalled on ubuntu runners → Testcontainers works
        env:
          TESTCONTAINERS_RYUK_DISABLED: 'true'
      - run: pnpm -r run check:publish
```

- [ ] **Step 2: Release workflow (changesets + OIDC trusted publishing, no NPM_TOKEN)**

Create `.github/workflows/release.yml`:

```yaml
name: Release
on:
  push: { branches: [main] }
permissions:
  contents: write
  pull-requests: write
  id-token: write   # OIDC → npm trusted publishing + provenance (ADR: PRD §Security)
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: npm install -g npm@latest   # ensure npm >= 11.5.1 for auto-provenance
      - run: pnpm build
      - uses: changesets/action@v1
        with:
          publish: pnpm changeset publish
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> Before the first real publish: create the npm org `drizzle-tx`, configure a **trusted publisher** per package on npmjs.com pointing at this workflow (select the "publish" action), and confirm `changesets/action` drives `changeset publish` under OIDC. If it demands a token, fall back to a least-privilege granular automation token in `NODE_AUTH_TOKEN` (documented in the PRD Phase 4).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: Node 20/22/24 matrix + OIDC trusted-publishing release workflow"
```

---

## Acceptance Signal (whole plan)

`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm -r run check:publish` all green locally and on the Node 20/22/24 CI matrix, with every PRD functional acceptance criterion covered by a passing unit (fake-adapter) or real-Postgres integration test — including cross-connection commit visibility, REQUIRES_NEW independence, NESTED partial rollback, pool-deadlock fail-fast, proxy transparency for builder + `db.query`, the never-throw Result behavior, and the ADR-0005 type-leak guard.

## Task Count: 11 (acceptable per writing-plans; large but single-shippable v1 as the user requested one comprehensive plan).
