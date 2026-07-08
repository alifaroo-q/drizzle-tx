import { describe, expect, it } from 'vitest';
import { TransactionContext } from './transaction-context.js';

describe('TransactionContext', () => {
  it('reports inactive with no current client outside run()', () => {
    const ctx = new TransactionContext<{ tag: string }>();
    expect(ctx.isActive()).toBe(false);
    expect(ctx.current()).toBeUndefined();
  });

  it('exposes the client and reports active inside run()', async () => {
    const ctx = new TransactionContext<{ tag: string }>();
    const client = { tag: 'tx1' };
    const seen = await ctx.run(client, async () => {
      expect(ctx.isActive()).toBe(true);
      return ctx.current();
    });
    expect(seen).toBe(client);
  });

  it('restores inactive after run() resolves', async () => {
    const ctx = new TransactionContext<{ tag: string }>();
    await ctx.run({ tag: 'tx1' }, async () => undefined);
    expect(ctx.isActive()).toBe(false);
    expect(ctx.current()).toBeUndefined();
  });

  it('nested run() shadows then restores the outer client', async () => {
    const ctx = new TransactionContext<{ tag: string }>();
    const outer = { tag: 'outer' };
    const inner = { tag: 'inner' };
    await ctx.run(outer, async () => {
      expect(ctx.current()).toBe(outer);
      await ctx.run(inner, async () => {
        expect(ctx.current()).toBe(inner);
      });
      expect(ctx.current()).toBe(outer);
    });
  });
});
