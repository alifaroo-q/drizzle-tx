import { defineConfig } from 'vitest/config';
import { swcPlugins } from './vitest.shared.js';

// The `nestjs-integration` project: real-Postgres tests that boot a Nest module against a
// Testcontainers database (started once via the shared globalSetup). The no-DB DI/CJS/no-op
// tests live in the sibling `nestjs-unit` project (`vitest.unit.config.ts`), which skips the
// container entirely. Both share the SWC transform from `vitest.shared.ts`; only this one
// pays for globalSetup.
export default defineConfig({
  plugins: swcPlugins,
  // Oxc would strip types before SWC emits decorator metadata — see vitest.shared.ts.
  oxc: false,
  test: {
    name: 'nestjs-integration',
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.integration.test.ts'],
    globalSetup: ['../../vitest.globalSetup.ts'],
    pool: 'forks',
    testTimeout: 30000,
    hookTimeout: 60000,
    restoreMocks: true,
  },
});
