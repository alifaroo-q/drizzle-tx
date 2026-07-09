import { type DrizzleTxError, notPoolBacked } from './errors.js';
import type { TxOptions } from './options.js';
import { Propagation } from './propagation.js';
import { assertNever } from './result.js';
import type { TransactionWork } from './transaction-manager.js';

/** A plain-data description of what a withTransaction call should do. The pure core
 *  produces this; the imperative shell interprets it. */
export type TxPlan =
  | { readonly kind: 'join'; readonly ignoredOptions?: TxOptions }
  | { readonly kind: 'new-root'; readonly options?: TxOptions }
  | { readonly kind: 'nested'; readonly ignoredOptions?: TxOptions }
  | { readonly kind: 'reject'; readonly error: DrizzleTxError };

export interface PropagationInputs {
  readonly propagation: Propagation;
  /** Snapshot of ALS state — NOT the live store. */
  readonly active: boolean;
  readonly supportsIndependentTransactions: boolean;
  readonly options?: TxOptions;
}

/** Options only "count" as ignored (and thus warn-worthy) when non-empty — this preserves
 *  the original `#warnIfOptions` predicate (`Object.keys(options).length > 0`) so an empty
 *  `{}` does not trigger a warning. */
const ignoredIfPresent = (options?: TxOptions): TxOptions | undefined =>
  options && Object.keys(options).length > 0 ? options : undefined;

/** Pure. The propagation truth-table. Exhaustive over Propagation. */
export function planTransaction(inputs: PropagationInputs): TxPlan {
  const { propagation, active, supportsIndependentTransactions, options } = inputs;
  switch (propagation) {
    case Propagation.Required:
      return active
        ? { kind: 'join', ignoredOptions: ignoredIfPresent(options) }
        : { kind: 'new-root', options };
    case Propagation.RequiresNew:
      if (active && !supportsIndependentTransactions)
        return { kind: 'reject', error: notPoolBacked() };
      return { kind: 'new-root', options };
    case Propagation.Nested:
      return active
        ? { kind: 'nested', ignoredOptions: ignoredIfPresent(options) }
        : { kind: 'new-root', options };
    default:
      return assertNever(propagation);
  }
}

/** Pure. Collapse the withTransaction overload shapes into a normalized triple. */
export function normalizeArgs<T, E>(
  a: Propagation | TxOptions | TransactionWork<T, E>,
  b?: TxOptions | TransactionWork<T, E>,
  c?: TransactionWork<T, E>,
): {
  readonly propagation: Propagation;
  readonly options?: TxOptions;
  readonly work: TransactionWork<T, E>;
} {
  if (typeof a === 'function') return { propagation: Propagation.Required, work: a };
  if (typeof a === 'string') {
    if (typeof b === 'function') return { propagation: a, work: b };
    return { propagation: a, options: b as TxOptions, work: c as TransactionWork<T, E> };
  }
  return { propagation: Propagation.Required, options: a, work: b as TransactionWork<T, E> };
}
