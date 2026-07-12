import type { DrizzleTxCapable } from '../../src/adapters/drizzle.js';
import { createDrizzleTx } from '../../src/create-drizzle-tx.js';
import type { DrizzleTxError } from '../../src/errors.js';
import { err, ok, type Result } from '../../src/result.js';
import type { TransactionScope } from '../../src/transaction-scope.js';

// A typed fake base client — the transactional client `db` must carry the SAME type.
declare const fakeDrizzle: DrizzleTxCapable & { select(): 'rows' };
const tx = createDrizzleTx({ drizzle: fakeDrizzle });

// `db` is typed identically to the base client (repos get full drizzle typing).
const _dbSelect: 'rows' = tx.db.select();

// `isActive` returns boolean.
const _active: boolean = tx.isActive();

async function surfaces(): Promise<void> {
  // Overload 1 (work only) must still compile — proves `.bind` did NOT collapse overloads.
  const r1 = await tx.withTransaction(async () => err({ kind: 'SoldOut' } as const));
  // The domain error union is preserved alongside DrizzleTxError.
  const _keep: Result<never, { kind: 'SoldOut' } | DrizzleTxError> = r1;
  // @ts-expect-error — the domain error must NOT be swallowed into just DrizzleTxError.
  const _collapsed: Result<never, DrizzleTxError> = r1;

  // Overload 2 (propagation, work) must still compile.
  const r2 = await tx.withTransaction('REQUIRES_NEW', async () => ok(1));
  const _r2: Result<number, DrizzleTxError> = r2;

  // `begin` returns the scope Result.
  const opened = await tx.begin();
  const _scope: Result<TransactionScope<typeof fakeDrizzle>, DrizzleTxError> = opened;

  void _keep;
  void _collapsed;
  void _r2;
  void _scope;
}
void surfaces;
void _dbSelect;
void _active;
