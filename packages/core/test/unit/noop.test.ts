import { describe, expect, it, vi } from 'vitest';
import { NoOpDrizzleAdapter } from '../../src/adapters/noop.js';

describe('NoOpDrizzleAdapter', () => {
  it('warns once on construction by default', () => {
    const warn = vi.fn();
    new NoOpDrizzleAdapter({ id: 'c1' }, { logger: { warn } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('transactions disabled'));
  });

  it('suppresses warning with quiet: true', () => {
    const warn = vi.fn();
    new NoOpDrizzleAdapter({ id: 'c1' }, { logger: { warn }, quiet: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('getBaseClient returns the client it was constructed with', () => {
    const client = { id: 'c1' };
    expect(new NoOpDrizzleAdapter(client, { quiet: true }).getBaseClient()).toBe(client);
  });

  it('records boundary outcomes in order and supports reset', async () => {
    const client = { id: 'c1' };
    const adapter = new NoOpDrizzleAdapter(client, { quiet: true });

    await adapter.wrapWithTransaction(undefined, async (tx) => {
      expect(tx).toBe(client);
      return 'ok';
    });
    await expect(
      adapter.wrapWithNestedTransaction(client, async (sp) => {
        expect(sp).toBe(client);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(adapter.getBoundaryLog()).toEqual([
      { kind: 'new-root', outcome: 'commit' },
      { kind: 'nested', outcome: 'rollback' },
    ]);

    adapter.resetBoundaryLog();
    expect(adapter.getBoundaryLog()).toEqual([]);
  });
});
