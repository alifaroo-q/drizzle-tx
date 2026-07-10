import { describe, expect, it } from 'vitest';
import { Propagation } from '../../src/propagation.js';
import { normalizeArgs, planTransaction } from '../../src/propagation-plan.js';
import { ok } from '../../src/result.js';

describe('planTransaction', () => {
  it('REQUIRED + inactive → new-root carrying options', () => {
    expect(
      planTransaction({
        propagation: Propagation.Required,
        active: false,
        supportsIndependentTransactions: true,
        options: { isolationLevel: 'serializable' },
      }),
    ).toEqual({ kind: 'new-root', options: { isolationLevel: 'serializable' } });
  });

  it('REQUIRED + active → join carrying ignoredOptions', () => {
    expect(
      planTransaction({
        propagation: Propagation.Required,
        active: true,
        supportsIndependentTransactions: true,
        options: { isolationLevel: 'serializable' },
      }),
    ).toEqual({ kind: 'join', ignoredOptions: { isolationLevel: 'serializable' } });
  });

  it('REQUIRED + active + empty options → join WITHOUT ignoredOptions (no warn)', () => {
    // Preserves the original `#warnIfOptions` predicate: empty {} must NOT warn.
    expect(
      planTransaction({
        propagation: Propagation.Required,
        active: true,
        supportsIndependentTransactions: true,
        options: {},
      }),
    ).toEqual({ kind: 'join', ignoredOptions: undefined });
  });

  it('REQUIRES_NEW + inactive → new-root', () => {
    expect(
      planTransaction({
        propagation: Propagation.RequiresNew,
        active: false,
        supportsIndependentTransactions: false,
      }),
    ).toEqual({ kind: 'new-root', options: undefined });
  });

  it('REQUIRES_NEW + active + not pool-backed → reject(NotPoolBacked)', () => {
    expect(
      planTransaction({
        propagation: Propagation.RequiresNew,
        active: true,
        supportsIndependentTransactions: false,
      }),
    ).toEqual({ kind: 'reject', error: { kind: 'NotPoolBacked' } });
  });

  it('REQUIRES_NEW + active + pool-backed → new-root', () => {
    expect(
      planTransaction({
        propagation: Propagation.RequiresNew,
        active: true,
        supportsIndependentTransactions: true,
      }),
    ).toEqual({ kind: 'new-root', options: undefined });
  });

  it('NESTED + active → nested carrying ignoredOptions', () => {
    expect(
      planTransaction({
        propagation: Propagation.Nested,
        active: true,
        supportsIndependentTransactions: true,
        options: { accessMode: 'read only' },
      }),
    ).toEqual({ kind: 'nested', ignoredOptions: { accessMode: 'read only' } });
  });

  it('NESTED + inactive → new-root', () => {
    expect(
      planTransaction({
        propagation: Propagation.Nested,
        active: false,
        supportsIndependentTransactions: true,
      }),
    ).toEqual({ kind: 'new-root', options: undefined });
  });
});

describe('normalizeArgs', () => {
  const work = async () => ok(1);

  it('(work) → REQUIRED, no options', () => {
    expect(normalizeArgs(work)).toEqual({ propagation: 'REQUIRED', work });
  });

  it('(propagation, work)', () => {
    expect(normalizeArgs('NESTED', work)).toEqual({ propagation: 'NESTED', work });
  });

  it('(propagation, options, work)', () => {
    const options = { isolationLevel: 'serializable' } as const;
    expect(normalizeArgs('REQUIRES_NEW', options, work)).toEqual({
      propagation: 'REQUIRES_NEW',
      options,
      work,
    });
  });

  it('(options, work) → REQUIRED with options', () => {
    const options = { accessMode: 'read only' } as const;
    expect(normalizeArgs(options, work)).toEqual({ propagation: 'REQUIRED', options, work });
  });
});
