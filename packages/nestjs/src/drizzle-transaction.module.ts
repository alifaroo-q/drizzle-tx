import {
  createTransactionalClient,
  DrizzleAdapter,
  type DrizzleTxCapable,
  TransactionManager,
} from '@drizzle-tx/core';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { DRIZZLE_BASE_DB, DRIZZLE_TX_CLIENT, DRIZZLE_TX_MANAGER } from './tokens.js';
import { TransactionHost } from './transaction-host.js';

export interface DrizzleTransactionModuleOptions {
  readonly drizzle: DrizzleTxCapable;
}
export interface DrizzleTransactionModuleAsyncOptions {
  // biome-ignore lint/suspicious/noExplicitAny: NestJS module metadata (imports/inject) is untyped by convention
  readonly imports?: any[];
  // biome-ignore lint/suspicious/noExplicitAny: NestJS injection tokens are heterogeneous
  readonly inject?: any[];
  readonly useFactory: (
    // biome-ignore lint/suspicious/noExplicitAny: factory args match the injected providers
    ...args: any[]
  ) => DrizzleTransactionModuleOptions | Promise<DrizzleTransactionModuleOptions>;
}

@Global()
@Module({})
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
        // biome-ignore lint/suspicious/noExplicitAny: factory args match the injected providers
        useFactory: async (...args: any[]) => (await options.useFactory(...args)).drizzle,
        inject: options.inject ?? [],
      },
      options.imports ?? [],
    );
  }

  // A class decorated with @Global()/@Module() cannot have a `static #private`
  // member under experimentalDecorators (TS18036), so this internal helper uses
  // TS-level `private` instead of a hard-private `#` identifier.
  // biome-ignore lint/suspicious/noExplicitAny: provider shape varies (useValue vs useFactory)
  private static build(baseDbProvider: any, imports: any[]): DynamicModule {
    return {
      module: DrizzleTransactionModule,
      imports,
      providers: [
        baseDbProvider,
        {
          provide: DRIZZLE_TX_MANAGER,
          inject: [DRIZZLE_BASE_DB],
          useFactory: (db: DrizzleTxCapable) => new TransactionManager(new DrizzleAdapter({ db })),
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
