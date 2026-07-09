import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm', 'cjs'],
  dts: true, // uses tsconfig isolatedDeclarations → fast Oxc emit
  clean: true,
  outDir: 'dist',
  target: 'es2023',
  // Package is `type: module`, so ESM emits as `.js` and CJS as `.cjs`
  // (matching the package.json `exports` map). Without this, tsdown defaults
  // to fixed `.mjs`/`.cjs`, which would leave `exports` pointing at missing files.
  fixedExtension: false,
});
