import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
// Type-only anchor so the `declare module 'vitest'` augmentation below resolves even when
// this file is typechecked in isolation (the editor's per-file program). Without it, the
// only vitest import is `vitest/node`, so module `'vitest'` isn't in the program and the
// augmentation fails with TS2664 → `keyof ProvidedContext` collapses to `never`.
import type {} from 'vitest';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer;

// Vitest 4 passes the root `TestProject` to global setup (the pre-v4 `GlobalSetupContext`
// type was removed); `provide` lives on it. See cli-api `loadGlobalSetupFile`.
export async function setup({ provide }: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  // Admin URI used by each worker to CREATE its own database.
  provide('adminUri', container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

declare module 'vitest' {
  // Must be `export interface` — `ProvidedContext` is re-exported by `vitest` (declared
  // in an internal chunk), so a non-exported augmentation would shadow instead of merge,
  // leaving `keyof ProvidedContext` as `never` for both `provide` and `inject`.
  export interface ProvidedContext {
    adminUri: string;
  }
}
