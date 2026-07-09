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
    ],
  },
});
