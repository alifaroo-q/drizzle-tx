import 'reflect-metadata';
import type { TransactionManager } from '@drizzle-tx/core';
import { ok } from '@drizzle-tx/core';
import { expect, it, vi } from 'vitest';
import { TransactionHost } from '../../src/transaction-host.js';

/** A recording stand-in for TransactionManager — every TransactionHost method is a thin
 *  delegate, so a fake manager is enough to prove the wiring (no DB, no real core). */
function makeFakeManager() {
  const client = { tag: 'tx-client' };
  const scope = { tx: client } as unknown;
  const calls: { begin: unknown[]; withTransaction: unknown[][] } = {
    begin: [],
    withTransaction: [],
  };
  const manager = {
    getTransactionClient: () => client,
    isTransactionActive: () => true,
    begin: (...args: unknown[]) => {
      calls.begin.push(args);
      return Promise.resolve(ok(scope));
    },
    withTransaction: (...args: unknown[]) => {
      calls.withTransaction.push(args);
      return Promise.resolve(ok('wt-result'));
    },
  } as unknown as TransactionManager<unknown>;
  return { manager, client, scope, calls };
}

it('tx getter delegates to manager.getTransactionClient', () => {
  const { manager, client } = makeFakeManager();
  expect(new TransactionHost(manager).tx).toBe(client);
});

it('isTransactionActive delegates to the manager', () => {
  const { manager } = makeFakeManager();
  expect(new TransactionHost(manager).isTransactionActive()).toBe(true);
});

it('begin forwards options to the manager and returns its Result', async () => {
  const { manager, scope, calls } = makeFakeManager();
  const host = new TransactionHost(manager);
  const options = { isolationLevel: 'serializable' } as const;

  const result = await host.begin(options);

  expect(calls.begin).toEqual([[options]]);
  expect(result).toEqual({ ok: true, value: scope });
});

it('withTransaction forwards its variadic args to the manager', async () => {
  const { manager, calls } = makeFakeManager();
  const host = new TransactionHost(manager);
  const work = vi.fn();

  await host.withTransaction(work);
  expect(calls.withTransaction).toEqual([[work, undefined, undefined]]);
});

it('registers itself so TransactionHost.get() resolves the instance', () => {
  const { manager } = makeFakeManager();
  const host = new TransactionHost(manager);
  expect(TransactionHost.get()).toBe(host);
});
