import { expect, it } from 'vitest';
import { Propagation } from '../../src/propagation.js';

it('exposes the three v1 propagation modes as string values', () => {
  expect(Propagation.Required).toBe('REQUIRED');
  expect(Propagation.RequiresNew).toBe('REQUIRES_NEW');
  expect(Propagation.Nested).toBe('NESTED');
  expect(Object.values(Propagation)).toEqual(['REQUIRED', 'REQUIRES_NEW', 'NESTED']);
});
