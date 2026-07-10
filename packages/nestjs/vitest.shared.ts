import swc from 'unplugin-swc';

// Single source of truth for the decorator-metadata transform shared by BOTH nestjs
// Vitest projects (`nestjs-unit`, `nestjs-integration`). SWC must be the SOLE TypeScript
// transformer: Vite 8 / Vitest 4 run Oxc first by default, which strips type annotations
// BEFORE unplugin-swc sees them — so SWC's `decoratorMetadata` emits `design:paramtypes`
// as `[undefined]` and type-based (non-`@Inject`) DI breaks. Each project therefore also
// sets `oxc: false`. Keep this in one place so the two projects can never drift apart.
export const swcPlugins = [
  swc.vite({
    module: { type: 'es6' },
    jsc: {
      target: 'es2022',
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
  }),
];
