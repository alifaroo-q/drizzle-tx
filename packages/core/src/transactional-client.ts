export function createTransactionalClient<TClient extends object>(resolve: () => TClient): TClient {
  return new Proxy(Object.create(null) as TClient, {
    get(_target, prop) {
      const active = resolve();
      const value = (active as Record<PropertyKey, unknown>)[prop as PropertyKey];
      // Bind functions to the REAL client so private-field access works.
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(active)
        : value;
    },
    has(_target, prop) {
      return prop in (resolve() as object);
    },
  });
}
