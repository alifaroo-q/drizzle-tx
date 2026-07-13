import type { DrizzleTxCapable } from '../../src/adapters/drizzle.js';
import { createDrizzleTx } from '../../src/create-drizzle-tx.js';
import type { DrizzleTxError } from '../../src/errors.js';
import { err, type Independent, ok, type Result, settle } from '../../src/result.js';
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

  // REQUIRES_NEW yields the BRAND, not a plain Result:
  const r2 = await tx.withTransaction('REQUIRES_NEW', async () => ok(1));
  const _branded: Independent<number, DrizzleTxError> = r2; // must hold
  const _stillResult: Result<number, DrizzleTxError> = r2; // Independent ⊆ Result — also holds

  // a non-REQUIRES_NEW form yields a PLAIN Result (NOT Independent):
  const r3 = await tx.withTransaction('REQUIRED', async () => ok(1));
  // @ts-expect-error — REQUIRED does not brand; a plain Result is not assignable to Independent
  const _notBranded: Independent<number, DrizzleTxError> = r3;

  // `begin` returns the scope Result.
  const opened = await tx.begin();
  const _scope: Result<TransactionScope<typeof fakeDrizzle>, DrizzleTxError> = opened;

  void _keep;
  void _collapsed;
  void _branded;
  void _stillResult;
  void _notBranded;
  void _scope;
}
void surfaces;

// the footgun is blocked at the work boundary, and settle() is the escape.
// ⚠️ DIAGNOSTIC LOCALITY (#31 "one real cost"): returning an inner Independent makes TS reject the
// whole OUTER `withTransaction('REQUIRES_NEW', …)` call (TS2769 "No overload matches"), NOT the
// `return inner` line — so the @ts-expect-error MUST sit on the outer call, or it's unused (TS2578)
// AND the real error goes unsuppressed. (Verified empirically by the plan reviewer.)
async function footgun() {
  // @ts-expect-error — returning an inner Independent as work output is blocked (error lands here)
  const outer = await tx.withTransaction('REQUIRES_NEW', async () => {
    const inner = await tx.withTransaction('REQUIRES_NEW', async () =>
      err({ kind: 'Inner' } as const),
    );
    return inner;
  });
  void outer;
  const outer2 = await tx.withTransaction('REQUIRES_NEW', async () => {
    const inner = await tx.withTransaction('REQUIRES_NEW', async () =>
      err({ kind: 'Inner' } as const),
    );
    return settle(inner); // conscious propagation — compiles
  });
  void outer2;
}
void footgun;
void _dbSelect;
void _active;
