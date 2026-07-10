import { expect, it } from 'vitest';
import { ok, Propagation } from '../../src/index.js';

it('core package is importable via its public entrypoint', () => {
  expect(typeof ok).toBe('function');
  expect(Propagation.Required).toBe('REQUIRED');
});
