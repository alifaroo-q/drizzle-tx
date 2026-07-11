import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { expect, it } from 'vitest';
import { InjectTransactionalClient } from '../../src/inject.js';
import { DRIZZLE_TX_CLIENT } from '../../src/tokens.js';

const sentinelClient = { tag: 'the-transactional-client' };

@Injectable()
class Consumer {
  constructor(@InjectTransactionalClient() readonly db: typeof sentinelClient) {}
}

it('InjectTransactionalClient injects the DRIZZLE_TX_CLIENT token', async () => {
  const ref = await Test.createTestingModule({
    providers: [{ provide: DRIZZLE_TX_CLIENT, useValue: sentinelClient }, Consumer],
  }).compile();

  expect(ref.get(Consumer).db).toBe(sentinelClient);
});
