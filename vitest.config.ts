import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Core unit tests only (no decorators, no DB). Live under test/unit/ —
        // physically separated from the real-Postgres suite in test/integration/
        // (which needs the container globalSetup), so no filename-based exclude is needed.
        test: {
          name: 'core-unit',
          globals: true,
          environment: 'node',
          include: ['packages/core/test/unit/**/*.test.ts'],
          restoreMocks: true,
        },
      },
      // ALL NestJS tests run under the package's OWN configs, which apply
      // unplugin-swc for decorator metadata. Referencing the config paths here
      // (not globbing nestjs files into a plain project) is REQUIRED — otherwise
      // decorator DI silently breaks under the root runner. Two projects: the fast
      // `nestjs-unit` (no DB, no globalSetup) and `nestjs-integration` (real Postgres).
      'packages/nestjs/vitest.unit.config.ts',
      'packages/nestjs/vitest.config.ts',
      {
        test: {
          name: 'core-integration',
          globals: true,
          environment: 'node',
          include: ['packages/core/test/integration/**/*.integration.test.ts'],
          globalSetup: ['./vitest.globalSetup.ts'],
          pool: 'forks',
          restoreMocks: true,
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
