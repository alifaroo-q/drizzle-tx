import 'reflect-metadata';
import { type DrizzleTxCapable, TransactionManager } from '@drizzle-tx/core';
import type { FactoryProvider, Provider } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DrizzleTransactionModule } from '../../src/drizzle-transaction.module.js';
import { DRIZZLE_BASE_DB, DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER } from '../../src/tokens.js';
import { TransactionHost } from '../../src/transaction-host.js';

/** A minimal drizzle stand-in the DrizzleAdapter can wrap without a database. */
const fakeDrizzle = {
  $client: undefined,
  transaction: async () => undefined,
} as unknown as DrizzleTxCapable;

const isFactory = (p: Provider): p is FactoryProvider =>
  typeof p === 'object' && p !== null && 'useFactory' in p;

function findProvider(providers: Provider[], token: symbol): FactoryProvider {
  const provider = providers.find((p) => isFactory(p) && p.provide === token);
  if (!provider || !isFactory(provider))
    throw new Error(`no factory provider for ${String(token)}`);
  return provider;
}

describe('DrizzleTransactionModule.forRoot', () => {
  it('is @Global and exports the public tokens + TransactionHost', () => {
    const mod = DrizzleTransactionModule.forRoot({ drizzle: fakeDrizzle });
    expect(mod.module).toBe(DrizzleTransactionModule);
    expect(mod.exports).toEqual([
      DRIZZLE_TX_CLIENT,
      DRIZZLE_TX_MANAGER,
      DRIZZLE_BASE_DB,
      TransactionHost,
    ]);
    expect(mod.providers).toContain(TransactionHost);
  });

  it('provides the base db as a value', () => {
    const mod = DrizzleTransactionModule.forRoot({ drizzle: fakeDrizzle });
    const baseDb = (mod.providers as Provider[]).find(
      (p): p is { provide: symbol; useValue: unknown } =>
        typeof p === 'object' && p !== null && 'useValue' in p && p.provide === DRIZZLE_BASE_DB,
    );
    expect(baseDb?.useValue).toBe(fakeDrizzle);
  });

  it('DRIZZLE_TX_MANAGER factory builds a TransactionManager over a DrizzleAdapter', () => {
    const mod = DrizzleTransactionModule.forRoot({ drizzle: fakeDrizzle });
    const managerProvider = findProvider(mod.providers as Provider[], DRIZZLE_TX_MANAGER);
    expect(managerProvider.inject).toEqual([DRIZZLE_BASE_DB]);

    const manager = managerProvider.useFactory(fakeDrizzle);
    expect(manager).toBeInstanceOf(TransactionManager);
  });

  it('DRIZZLE_TX_CLIENT factory yields a live proxy over the manager’s active client', () => {
    const mod = DrizzleTransactionModule.forRoot({ drizzle: fakeDrizzle });
    const clientProvider = findProvider(mod.providers as Provider[], DRIZZLE_TX_CLIENT);
    expect(clientProvider.inject).toEqual([DRIZZLE_TX_MANAGER]);

    // Feed it a fake manager whose active client has an observable property.
    const active = { marker: 'live' };
    const fakeManager = {
      getTransactionClient: () => active,
    } as unknown as TransactionManager<object>;
    const proxy = clientProvider.useFactory(fakeManager) as { marker: string };
    expect(proxy.marker).toBe('live');
  });
});

describe('DrizzleTransactionModule.forRootAsync', () => {
  it('base-db factory awaits useFactory and unwraps `.drizzle`', async () => {
    const mod = DrizzleTransactionModule.forRootAsync({
      useFactory: async () => ({ drizzle: fakeDrizzle }),
    });
    const baseDb = findProvider(mod.providers as Provider[], DRIZZLE_BASE_DB);
    expect(baseDb.inject).toEqual([]); // defaults to [] when not supplied
    await expect(baseDb.useFactory()).resolves.toBe(fakeDrizzle);
  });

  it('propagates imports and inject from the async options', () => {
    class SomeModule {}
    const mod = DrizzleTransactionModule.forRootAsync({
      imports: [SomeModule],
      inject: [DRIZZLE_BASE_DB],
      useFactory: () => ({ drizzle: fakeDrizzle }),
    });
    expect(mod.imports).toEqual([SomeModule]);
    expect(findProvider(mod.providers as Provider[], DRIZZLE_BASE_DB).inject).toEqual([
      DRIZZLE_BASE_DB,
    ]);
  });
});
