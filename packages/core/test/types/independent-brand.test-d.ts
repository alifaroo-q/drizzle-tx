import type { TransactionWork } from '../../src/propagation-plan.js';
import type { Independent, Result } from '../../src/result.js';
import { err, ok, settle } from '../../src/result.js';

declare const indep: Independent<number, { kind: 'X' }>;

// (1) inspection is UNTAXED — .ok/.value/.error read directly through the brand:
const _isOk: boolean = indep.ok;
if (indep.ok) {
  const _v: number = indep.value;
  void _v;
} else {
  const _e: { kind: 'X' } = indep.error;
  void _e;
}
void _isOk;

// (2) an Independent IS assignable to a plain Result (superset), so inspection/adaptation works:
const _asResult: Result<number, { kind: 'X' }> = indep;
void _asResult;

// (3) settle() unwraps to a plain Result (the conscious escape):
const _settled: Result<number, { kind: 'X' }> = settle(indep);
void _settled;

// (4) THE GUARDRAIL: an Independent cannot be RETURNED as transactional work output.
//     TransactionWork's return is poisoned; a branded value violates { [IND]?: never }.
// @ts-expect-error — returning an Independent as work output is the footgun the brand blocks
const _blockedWork: TransactionWork<number, { kind: 'X' }> = async () => indep;
void _blockedWork;

// (5) a plain Result work is UNAFFECTED (assignable to the poisoned return):
const _plainWork: TransactionWork<number, { kind: 'X' }> = async () =>
  Math.random() > 1 ? ok(1) : err({ kind: 'X' as const });
void _plainWork;

// (6) settle(inner) IS a valid work return (conscious propagation):
const _settleWork: TransactionWork<number, { kind: 'X' }> = async () => settle(indep);
void _settleWork;
