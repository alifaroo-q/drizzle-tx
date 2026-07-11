import 'reflect-metadata';
import { type DrizzleTxError, ok, type Result } from '@drizzle-tx/core';
import { describe, expect, it } from 'vitest';
import { Transactional } from '../../src/transactional.decorator.js';

describe('@Transactional (descriptor-level behavior)', () => {
  it('throws when applied to a descriptor whose value is not a function', () => {
    const decorate = Transactional();
    expect(() =>
      // Simulate a legacy decorator landing on a non-method (e.g. a property).
      decorate({}, 'notAMethod', { value: 123 } as never),
    ).toThrow(/can only decorate methods/);
  });

  it('preserves metadata NestJS attached to the original method', () => {
    const original = async (): Promise<Result<number, DrizzleTxError>> => ok(1);
    Reflect.defineMetadata('guard:key', ['RolesGuard'], original);

    const descriptor = {
      value: original,
      writable: true,
      enumerable: false,
      configurable: true,
    };
    Transactional()({}, 'doIt', descriptor as never);

    // The decorator swaps in a Proxy; the copied metadata must ride along to it.
    expect(descriptor.value).not.toBe(original);
    expect(Reflect.getMetadata('guard:key', descriptor.value)).toEqual(['RolesGuard']);
  });
});
