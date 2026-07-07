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
