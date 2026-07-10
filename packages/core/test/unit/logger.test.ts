import { expect, it, vi } from 'vitest';
import { consoleLogger, noopLogger } from '../../src/logger.js';

it('noopLogger.warn does nothing', () => {
  expect(() => noopLogger.warn('x')).not.toThrow();
});

it('consoleLogger.warn prefixes and forwards to console.warn', () => {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  consoleLogger.warn('stripped isolation');
  expect(spy).toHaveBeenCalledWith('[drizzle-tx] stripped isolation');
});
