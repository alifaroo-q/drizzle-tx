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
  // Vite 8 / Vitest 4 transform TypeScript with Oxc by default, which strips type
  // annotations BEFORE unplugin-swc runs — leaving SWC's `decoratorMetadata` with no
  // types, so `design:paramtypes` emits as `[undefined]` and type-based DI breaks.
  // Disabling Oxc makes unplugin-swc the sole transformer (emitDecoratorMetadata works).
  oxc: false,
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
