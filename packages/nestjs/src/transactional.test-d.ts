import type { DrizzleTxError, Result } from '@drizzle-tx/core';
import { Transactional } from './transactional.decorator.js';

// GOOD: error union includes DrizzleTxError → compiles.
class Good {
  @Transactional()
  async ok(): Promise<Result<number, 'domain' | DrizzleTxError>> {
    return { ok: true, value: 1 };
  }
}

// BAD: error union omits DrizzleTxError → must be a compile error.
class Bad {
  // @ts-expect-error — method error union must include DrizzleTxError
  @Transactional()
  async nope(): Promise<Result<number, 'domain'>> {
    return { ok: true, value: 1 };
  }
}

export { Bad, Good };
