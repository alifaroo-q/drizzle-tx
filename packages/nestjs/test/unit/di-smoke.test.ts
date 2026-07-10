import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { expect, it } from 'vitest';

@Injectable()
class Dep {
  readonly tag = 'dep';
}

@Injectable()
class Consumer {
  // Constructor param DI relies on emitDecoratorMetadata design:paramtypes.
  constructor(@Inject(Dep) readonly dep: Dep) {}
}

it('emitDecoratorMetadata drives constructor DI (TS6/SWC)', async () => {
  const moduleRef = await Test.createTestingModule({ providers: [Dep, Consumer] }).compile();
  const consumer = moduleRef.get(Consumer);
  expect(consumer.dep).toBeInstanceOf(Dep);
  expect(consumer.dep.tag).toBe('dep');
});
