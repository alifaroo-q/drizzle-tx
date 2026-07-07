# @drizzle-tx/nestjs

The NestJS 11 adapter for [`@drizzle-tx`](https://github.com/) — Spring-`@Transactional`-style implicit transaction propagation for [Drizzle ORM](https://orm.drizzle.team/), with no prop-drilling of the transaction handle.

Built on [`@drizzle-tx/core`](https://www.npmjs.com/package/@drizzle-tx/core). Explicit `Result` model — it never throws for modeled conditions.

## Install

```bash
pnpm add @drizzle-tx/nestjs @drizzle-tx/core drizzle-orm pg
```

Peers: `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs`, `drizzle-orm`.

> Requires `experimentalDecorators` + `emitDecoratorMetadata` in your app's `tsconfig.json` (standard for NestJS), and a **Pool-backed** Drizzle instance.

## Exports

- `DrizzleTransactionModule.forRoot({ drizzle })` / `.forRootAsync({ inject, useFactory })`
- `DRIZZLE_TX_CLIENT` — inject the transparent transactional client
- `@Transactional(propagation?)` — method decorator (returns `Result`, never throws)
- `TransactionHost` — imperative `withTransaction()` / `tx` / `isTransactionActive()`
- `InjectTransactionalClient()` — shorthand for `@Inject(DRIZZLE_TX_CLIENT)`
- `DRIZZLE_TX_MANAGER`, `DRIZZLE_BASE_DB` — advanced tokens
- Re-exported from core: `Propagation`, `ok`, `err`, `isOk`, `isErr`, `assertNever`, and the `Result`, `DrizzleTxError`, `TxOptions` types

## Usage

```ts
// app.module.ts
@Module({ imports: [DrizzleTransactionModule.forRoot({ drizzle: db })] })
export class AppModule {}
```

```ts
// user.repo.ts
@Injectable()
export class UserRepo {
  constructor(@Inject(DRIZZLE_TX_CLIENT) private readonly db: NodePgDatabase<typeof relations>) {}
  create(name: string) {
    return this.db.insert(users).values({ name }).returning();
  }
}
```

```ts
// billing.service.ts — the error union must include DrizzleTxError (compiler-enforced)
@Injectable()
export class BillingService {
  constructor(private readonly users: UserRepo) {}

  @Transactional()
  async signup(name: string): Promise<Result<number, 'DUPLICATE' | DrizzleTxError>> {
    const [u] = await this.users.create(name);
    return ok(u.id);
  }

  @Transactional(Propagation.RequiresNew)
  async audit(event: string): Promise<Result<null, DrizzleTxError>> {
    await this.users.create(`audit:${event}`);
    return ok(null);
  }
}
```

Controllers unwrap the `Result` and are the sole throw boundary (exhaustive `err` → `HttpException`). See the [repository root README](https://github.com/) for the full controller example, the propagation table, and the Pool-sizing/deadlock limitations.

## License

MIT © Ali Farooq
