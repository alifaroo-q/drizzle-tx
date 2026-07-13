import { afterEach, describe, expect, it, vi } from 'vitest';
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
      return err(
        transactionAborted({
          message: 'COMMIT failed',
          sqlState: undefined,
          cause: new Error('COMMIT failed'),
        }),
      );
    };
    const opened = await openScope(run, captureClient, { warn });
    if (!opened.ok) throw new Error('expected ok');

    opened.value.commit();
    await opened.value[Symbol.asyncDispose]();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to settle'));
  });

  it('returns err(TransactionAborted) when the tx errors before the client is captured', async () => {
    const run: Runner = async () =>
      err(
        transactionAborted({
          message: 'could not connect',
          sqlState: undefined,
          cause: new Error('could not connect'),
        }),
      );
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

afterEach(() => {
  vi.useRealTimers();
});

describe('openScope — disposeTimeoutMs leak backstop', () => {
  it('OFF by default: no timer armed when disposeTimeoutMs is undefined', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }); // no 4th arg
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(warn).not.toHaveBeenCalled(); // zero behavior change
    await opened.value[Symbol.asyncDispose](); // clean up the parked work
  });

  it('fires on elapse: forces rollback, releases the gate, warns loudly', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    let settled: Result<void, symbol> | undefined;
    // NOTE: this fake Runner captures the work's return directly (not routed through the manager's
    // #runInBoundary), so `settled` is the raw rollback sentinel — assert only `.ok === false` here.
    const run: Runner = async (work) => {
      const r = await work();
      settled = r;
      return r;
    };
    const opened = await openScope(run, captureClient, { warn }, 1000);
    if (!opened.ok) throw new Error('expected ok');
    opened.value.commit(); // even a prior commit() is overridden by the backstop
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not disposed within 1000ms'));
    expect(settled?.ok).toBe(false); // forced default-deny rollback (sentinel), not commit
  });

  it('normal dispose before elapse clears the timer (no spurious warn)', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }, 1000);
    if (!opened.ok) throw new Error('expected ok');
    opened.value.commit();
    await opened.value[Symbol.asyncDispose]();
    await vi.advanceTimersByTimeAsync(5000); // long past the timeout
    expect(warn).not.toHaveBeenCalled();
  });

  it('late dispose after the backstop fired is idempotent (no throw, no second warn)', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }, 1000);
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(opened.value[Symbol.asyncDispose]()).resolves.toBeUndefined(); // no throw
    expect(warn).toHaveBeenCalledTimes(1); // no second warn (already settled via sentinel)
  });

  it('a non-finite disposeTimeoutMs (Infinity) arms no timer', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }, Number.POSITIVE_INFINITY);
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(warn).not.toHaveBeenCalled();
    await opened.value[Symbol.asyncDispose]();
  });

  it.each([
    0, -1,
  ])('a non-positive disposeTimeoutMs (%s) is treated as OFF — never rolls back live work', async (timeout) => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const run: Runner = async (work) => work();
    const opened = await openScope(run, captureClient, { warn }, timeout);
    if (!opened.ok) throw new Error('expected ok');
    opened.value.commit();
    await vi.advanceTimersByTimeAsync(1_000_000); // no immediate/eventual forced rollback
    expect(warn).not.toHaveBeenCalled();
    await opened.value[Symbol.asyncDispose]();
  });

  it('backstop that fires after the tx self-terminated does not warn (nothing to reclaim)', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    // The tx starts (work captures the client) but then ends on its own — connection drop — before
    // dispose: the runner abandons the parked work and settles early. When the timer later elapses
    // there is nothing left to reclaim, so it must stay silent.
    const run: Runner = async (work) => {
      void work(); // captures the client + parks on the gate; NOT awaited
      return err(Symbol('conn-dropped')); // transaction dies on its own
    };
    const opened = await openScope(run, captureClient, { warn }, 1000);
    if (!opened.ok) throw new Error('expected ok');
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).not.toHaveBeenCalled(); // the "not disposed" warning would be misleading here
    await opened.value[Symbol.asyncDispose]();
  });
});
