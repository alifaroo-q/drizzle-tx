import { describe, expect, it } from 'vitest';
import { createDrizzleTx } from '../../src/create-drizzle-tx.js';
import { UnsupportedDriverError } from '../../src/driver-capability.js';
import { ok } from '../../src/result.js';

const ENTITY_KIND = Symbol.for('drizzle:entityKind');

/** A fake Pool-backed drizzle client: `.transaction(fn)` runs `fn` against a distinct
 *  "tx" client so we can observe the transactional-client auto-join. `$client` carries
 *  the structural pool markers `DrizzleAdapter.isPoolBacked` looks for. */
// biome-ignore lint/suspicious/noExplicitAny: minimal structural fake for a no-DB unit test
function makeFakeDrizzle(): any {
  const $client = { totalCount: 1, idleCount: 1, connect() {} };
  // biome-ignore lint/suspicious/noExplicitAny: recursive fake client shape
  const makeClient = (label: 'base' | 'tx'): any => ({
    label,
    $client,
    // biome-ignore lint/suspicious/noExplicitAny: fake transaction callback
    transaction(fn: (tx: any) => Promise<unknown>) {
      return fn(makeClient('tx'));
    },
  });
  return makeClient('base');
}

describe('createDrizzleTx', () => {
  it('returns the documented shape', () => {
    const tx = createDrizzleTx({ drizzle: makeFakeDrizzle() });
    expect(typeof tx.withTransaction).toBe('function');
    expect(typeof tx.begin).toBe('function');
    expect(typeof tx.isTransactionActive).toBe('function');
    expect(tx.manager).toBeDefined();
    expect(tx.db).toBeDefined();
  });

  it('db resolves to the base client outside a transaction', () => {
    const tx = createDrizzleTx({ drizzle: makeFakeDrizzle() });
    // biome-ignore lint/suspicious/noExplicitAny: reading the fake's label marker
    expect((tx.db as any).label).toBe('base');
    expect(tx.isTransactionActive()).toBe(false);
  });

  it('db auto-joins the active transaction inside withTransaction', async () => {
    const tx = createDrizzleTx({ drizzle: makeFakeDrizzle() });
    let seenInside: string | undefined;
    const result = await tx.withTransaction(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: reading the fake's label marker
      seenInside = (tx.db as any).label; // resolves live to the tx client
      return ok(123);
    });
    expect(seenInside).toBe('tx');
    expect(result).toEqual({ ok: true, value: 123 });
    // biome-ignore lint/suspicious/noExplicitAny: reading the fake's label marker
    expect((tx.db as any).label).toBe('base'); // back to base after the tx
  });

  it('bound methods survive destructuring (this-binding preserved)', async () => {
    const { withTransaction, isTransactionActive } = createDrizzleTx({
      drizzle: makeFakeDrizzle(),
    });
    expect(isTransactionActive()).toBe(false); // would throw on private-field access if `this` were lost
    await expect(withTransaction(async () => ok('done'))).resolves.toEqual({
      ok: true,
      value: 'done',
    });
  });

  it('throws UnsupportedDriverError at construction for a non-interactive driver', () => {
    class NeonHttpDatabase {
      static [ENTITY_KIND] = 'NeonHttpDatabase';
      $client = () => {}; // neon-http $client is the neon() function
      transaction() {
        throw new Error('No transactions support in neon-http driver');
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: forcing the incapable driver through the gate
    expect(() => createDrizzleTx({ drizzle: new NeonHttpDatabase() as any })).toThrow(
      UnsupportedDriverError,
    );
  });
});
