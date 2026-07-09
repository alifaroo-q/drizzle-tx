import 'reflect-metadata';
import { type DrizzleTxError, ok, type Result } from '@drizzle-tx/core';
import { expect, it } from 'vitest';
import { Transactional } from './transactional.decorator.js';

class Svc {
  @Transactional()
  async doIt(): Promise<Result<number, DrizzleTxError>> {
    return ok(1);
  }
}

it('returns err(HostNotInitialized) when no module initialized the host', async () => {
  // This file boots NO NestJS module. With Vitest `forks` + per-file isolation,
  // the process-global TransactionHost registry is empty here.
  const result = await new Svc().doIt();
  expect(result).toEqual({
    ok: false,
    error: { kind: 'HostNotInitialized', connectionName: undefined },
  });
});
