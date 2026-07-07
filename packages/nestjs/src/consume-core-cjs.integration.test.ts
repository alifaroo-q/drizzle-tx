import { expect, it } from 'vitest';

it('resolves @drizzle-tx/core from a CJS context', async () => {
  // The nestjs package is CJS; ensure require-resolution of the core CJS build works.
  const core = await import('@drizzle-tx/core');
  expect(typeof core.ok).toBe('function');
  expect(core.Propagation.Required).toBe('REQUIRED');
});
