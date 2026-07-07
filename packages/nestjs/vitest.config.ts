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
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['../../vitest.globalSetup.ts'],
    pool: 'forks',
    testTimeout: 30000,
    hookTimeout: 60000,
    restoreMocks: true,
  },
});
