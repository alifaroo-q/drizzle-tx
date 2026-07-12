import {
  createDrizzleTx,
  createTransactionalClient,
  type DrizzleTxCapable,
  type TransactionManager,
} from '@drizzle-tx/core';
import {
  type DynamicModule,
  type FactoryProvider,
  Global,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { DRIZZLE_BASE_DB, DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER } from './tokens.js';
import { TransactionHost } from './transaction-host.js';

export interface DrizzleTransactionModuleOptions {
  readonly drizzle: DrizzleTxCapable;
}
export interface DrizzleTransactionModuleAsyncOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: FactoryProvider['inject'];
  readonly useFactory: (
    // biome-ignore lint/suspicious/noExplicitAny: injected factory args are heterogeneous (NestJS convention)
    ...args: any[]
  ) => DrizzleTransactionModuleOptions | Promise<DrizzleTransactionModuleOptions>;
}

@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: this class is a NestJS module, which is expected to have only static methods
export class DrizzleTransactionModule {
  static forRoot(options: DrizzleTransactionModuleOptions): DynamicModule {
    return DrizzleTransactionModule.build(
      { provide: DRIZZLE_BASE_DB, useValue: options.drizzle },
      [],
    );
  }

  static forRootAsync(options: DrizzleTransactionModuleAsyncOptions): DynamicModule {
    return DrizzleTransactionModule.build(
      {
        provide: DRIZZLE_BASE_DB,
        // biome-ignore lint/suspicious/noExplicitAny: injected factory args are heterogeneous (NestJS convention)
        useFactory: async (...args: any[]) => (await options.useFactory(...args)).drizzle,
        inject: options.inject ?? [],
      },
      options.imports ?? [],
    );
  }

  // A class decorated with @Global()/@Module() cannot have a `static #private`
  // member under experimentalDecorators (TS18036), so this internal helper uses
  // TS-level `private` instead of a hard-private `#` identifier.
  private static build(
    baseDbProvider: Provider,
    imports: ModuleMetadata['imports'],
  ): DynamicModule {
    return {
      module: DrizzleTransactionModule,
      imports,
      providers: [
        baseDbProvider,
        {
          // Delegate manager construction to the canonical factory (runs the driver gate;
          // defaults can't drift). The client is derived from the DRIZZLE_TX_MANAGER token
          // — the same shape `createDrizzleTx` builds internally — so the testing seam
          // (`overrideProvider(DRIZZLE_TX_MANAGER)`) still swaps both manager and client.
          provide: DRIZZLE_TX_MANAGER,
          inject: [DRIZZLE_BASE_DB],
          useFactory: (db: DrizzleTxCapable) => createDrizzleTx({ drizzle: db }).manager,
        },
        {
          provide: DRIZZLE_TX_CLIENT,
          inject: [DRIZZLE_TX_MANAGER],
          useFactory: (m: TransactionManager<object>) =>
            createTransactionalClient(() => m.getTransactionClient()),
        },
        TransactionHost,
      ],
      exports: [DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER, DRIZZLE_BASE_DB, TransactionHost],
    };
  }
}
