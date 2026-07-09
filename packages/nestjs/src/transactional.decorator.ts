import {
  type DrizzleTxError,
  err,
  hostNotInitialized,
  type Propagation,
  type Result,
} from '@drizzle-tx/core';
import { TransactionHost } from './transaction-host.js';

type TxMethod<A extends unknown[], T, E> = (...args: A) => Promise<Result<T, E>>;

/** ADR-0005: the decorated method's error union must INCLUDE DrizzleTxError
 *  (E must be a supertype). Encoded as `[DrizzleTxError] extends [E]` — tuple-wrapped
 *  to avoid union distribution. When the constraint fails, the descriptor param
 *  resolves to a branded error type, so the real method descriptor is not assignable
 *  → a compile error at the decoration site. NOTE: this is the DIRECTION of the check
 *  (`DrizzleTxError extends E`), the inverse of a plain `E extends DrizzleTxError` bound. */
type GuardDescriptor<A extends unknown[], T, E> = [DrizzleTxError] extends [E]
  ? TypedPropertyDescriptor<TxMethod<A, T, E>>
  : { readonly __drizzleTxError: 'The method Result error union must include DrizzleTxError' };

export function Transactional(propagation?: Propagation) {
  return <A extends unknown[], T, E>(
    _target: object,
    propertyKey: string | symbol,
    descriptor: GuardDescriptor<A, T, E>,
  ): void => {
    const d = descriptor as TypedPropertyDescriptor<TxMethod<A, T, E>>;
    const original = d.value;
    if (typeof original !== 'function') {
      throw new Error(
        `@Transactional can only decorate methods; ${String(propertyKey)} is not a function.`,
      );
    }

    d.value = new Proxy(original, {
      apply(target, thisArg, args: A) {
        const host = TransactionHost.get();
        if (!host) {
          return Promise.resolve(err(hostNotInitialized(undefined)));
        }
        const bound = (): Promise<Result<T, E>> =>
          Reflect.apply(target, thisArg, args) as Promise<Result<T, E>>;
        return propagation ? host.withTransaction(propagation, bound) : host.withTransaction(bound);
      },
    }) as TxMethod<A, T, E>;

    // Preserve metadata NestJS may have attached (guards, interceptors, etc.).
    for (const key of Reflect.getMetadataKeys(original)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, original), d.value as object);
    }
    // Legacy method decorators mutate the descriptor in place; return void.
  };
}
