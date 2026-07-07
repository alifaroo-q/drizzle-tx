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
