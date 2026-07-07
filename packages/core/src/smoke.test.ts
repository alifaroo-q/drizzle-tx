import { expect, it } from 'vitest';
import { version } from './index.js';

it('core package is importable', () => {
  expect(version).toBe('0.0.0');
});
