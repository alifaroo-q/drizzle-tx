import { describe, expect, it, vi } from 'vitest';
import { transactionAborted } from '../../src/errors.js';
import { err, ok, type Result } from '../../src/result.js';
import { openScope } from '../../src/transaction-scope.js';

/** The manager-shaped runner openScope drives: it runs `work` inside a "transaction"
 *  and resolves with whatever the transaction settled to. */
type Runner = (
  work: () => Promise<Result<void, symbol>>,
) => Promise<Result<void, symbol | ReturnType<typeof transactionAborted>>>;

const client = { tag: 'tx' };
const captureClient = () => client;

describe('openScope', () => {
  it('exposes the captured tx client on the scope', async () => {
    const run: Runner = async (work) => {
      // Kick the work off (captures client + parks on the gate) but resolve `openScope`
      // via the `started` race — the tx stays open until dispose.
      void work();
      return ok(undefined);
    };
    const opened = await openScope(run, captureClient, { warn: vi.fn() });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.value.tx).toBe(client);
  });

  it('commit() then dispose settles ok and does NOT warn', async () => {
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn });
    if (!opened.ok) throw new Error('expected ok');

    opened.value.commit();
    await opened.value[Symbol.asyncDispose]();
    expect(warn).not.toHaveBeenCalled();
  });

  it('dispose WITHOUT commit rolls back via the sentinel and does NOT warn', async () => {
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn });
    if (!opened.ok) throw new Error('expected ok');

    await opened.value[Symbol.asyncDispose]();
    expect(warn).not.toHaveBeenCalled(); // the rollback sentinel is expected, not a failure
  });

  it('warns when the transaction settles with a non-sentinel error (commit failed)', async () => {
    const warn = vi.fn();
    // Simulate a COMMIT that fails: the parked work resolves, but the runner surfaces a
    // real DrizzleTxError rather than the internal rollback sentinel.
    const run: Runner = async (work) => {
      await work();
      return err(transactionAborted(new Error('COMMIT failed')));
    };
    const opened = await openScope(run, captureClient, { warn });
    if (!opened.ok) throw new Error('expected ok');

    opened.value.commit();
    await opened.value[Symbol.asyncDispose]();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to settle'));
  });

  it('returns err(TransactionAborted) when the tx errors before the client is captured', async () => {
    const run: Runner = async () => err(transactionAborted(new Error('could not connect')));
    const opened = await openScope(run, captureClient, { warn: vi.fn() });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.kind).toBe('TransactionAborted');
  });

  it('returns err(TransactionAborted) when the tx ends ok before the client is captured', async () => {
    const run: Runner = async () => ok(undefined); // never runs work → client never captured
    const opened = await openScope(run, captureClient, { warn: vi.fn() });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.kind).toBe('TransactionAborted');
      expect(String(opened.error.cause)).toContain('closed before it started');
    }
  });
});
