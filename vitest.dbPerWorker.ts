import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { inject } from 'vitest';
import { relations } from './test/schema.js';

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

  // rc.4 signature: pass the existing Pool via the `client` config key.
  // `drizzle(pool, { relations })` is NOT a valid rc.4 overload — it would
  // destructure the Pool as a config object and silently build a new empty pool.
  const db = drizzle({ client: pool, relations });
  return { db, pool, close: () => pool.end() };
}
