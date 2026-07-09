import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { inject } from 'vitest';
import { relations } from './test/schema.js';

// The `ProvidedContext` augmentation must live here too, not only in the paired
// global setup: this file uses `inject('adminUri')` but doesn't import globalSetup,
// so when a tool typechecks it in isolation (e.g. the editor's per-file program),
// the augmentation from globalSetup isn't loaded and `keyof ProvidedContext` would be
// `never`. Identical `export interface` declarations merge, so declaring it in both
// files is safe. See `vitest.globalSetup.ts` for the `export interface` rationale.
declare module 'vitest' {
  export interface ProvidedContext {
    adminUri: string;
  }
}

export interface TestDb {
  db: NodePgDatabase<typeof relations>;
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

// Monotonic per-process counter. `VITEST_POOL_ID` is a reused worker-SLOT id, and
// `createTestDb` can be called more than once per worker (even concurrently via
// `Promise.all`). `Date.now()` alone is captured synchronously, so two calls in the
// same millisecond would collide on `CREATE DATABASE`; the counter makes the name
// unique within the worker regardless of timing.
let seq = 0;

/** Create an isolated database for this worker and return a migrated Drizzle instance.
 *  poolMax lets deadlock tests use a tiny pool. */
export async function createTestDb(poolMax = 10): Promise<TestDb> {
  const adminUri = inject('adminUri');
  const workerId = process.env.VITEST_POOL_ID ?? '0';
  const dbName = `test_w${workerId}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

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

  // rc.4 signature: pass the existing Pool via the `client` config key.
  // `drizzle(pool, { relations })` is NOT a valid rc.4 overload — it would
  // destructure the Pool as a config object and silently build a new empty pool.
  const db = drizzle({ client: pool, relations });
  return { db, pool, close: () => pool.end() };
}
