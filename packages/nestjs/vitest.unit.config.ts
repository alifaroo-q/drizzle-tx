import { defineConfig } from 'vitest/config';
import { swcPlugins } from './vitest.shared.js';

// The `nestjs-unit` project: DI/decorator-metadata, CJS-resolution, and no-op-adapter tests
// that bootstrap Nest but touch NO database — so no Testcontainers globalSetup (fast). It is
// otherwise identical to `nestjs-integration`: same SWC transform (decorators still need it)
// and `pool: 'forks'` (the process-global TransactionHost registry must be isolated per file
// — e.g. transactional-host-miss asserts an EMPTY registry). See ADR-0004.
export default defineConfig({
  plugins: swcPlugins,
  // Oxc would strip types before SWC emits decorator metadata — see vitest.shared.ts.
  oxc: false,
  test: {
    name: 'nestjs-unit',
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    pool: 'forks',
    restoreMocks: true,
  },
});
