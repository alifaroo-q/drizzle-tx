/** drizzle-orm tags every DB class with this GLOBAL-registry symbol
 *  (`Symbol.for("drizzle:entityKind")`), so we can read it without importing
 *  drizzle-orm — keeping core's optional-peer stance (ADR-0010). */
const ENTITY_KIND = Symbol.for('drizzle:entityKind');

/** Known drizzle `entityKind`s that cannot host ANY interactive transaction.
 *  Extensible: add a new *non-interactive* driver's kind here (denylist — new
 *  *interactive* drivers need no change). See ADR-0010 / ADR-0009 driver matrix. */
const NON_INTERACTIVE_ENTITY_KINDS: ReadonlySet<string> = new Set(['NeonHttpDatabase']);

/** Thrown at assembly time (not a `DrizzleTxError` runtime variant — ADR-0010) when a
 *  driver cannot host interactive transactions. `driver` is the offending entityKind. */
export class UnsupportedDriverError extends Error {
  readonly driver: string;
  constructor(driver: string) {
    super(
      `@drizzle-tx: driver "${driver}" cannot host interactive transactions. ` +
        'Neon HTTP is one-shot / non-interactive — use drizzle-orm/neon-serverless ' +
        '(WebSocket Pool) or node-postgres instead.',
    );
    this.name = 'UnsupportedDriverError';
    this.driver = driver;
  }
}

/** Read the drizzle `entityKind` off a client. A static class field is inherited through
 *  the constructor's prototype chain, so a single read already yields the most-derived kind
 *  (a subclass with no own `entityKind` resolves to its parent's). Returns `undefined` for
 *  non-drizzle / non-object values. */
export function readDrizzleEntityKind(client: unknown): string | undefined {
  if (client === null || (typeof client !== 'object' && typeof client !== 'function')) {
    return undefined;
  }
  const ctor = Object.getPrototypeOf(client)?.constructor as
    | Record<PropertyKey, unknown>
    | undefined;
  const kind = ctor?.[ENTITY_KIND];
  return typeof kind === 'string' ? kind : undefined;
}

/** Throw `UnsupportedDriverError` if `client` is a driver KNOWN to be unable to host
 *  interactive transactions (denylist, ADR-0010). This screens the known-bad set — it does
 *  NOT prove capability: interactive, unknown, hand-rolled, and testing clients all pass. */
export function rejectUnsupportedDriver(client: unknown): void {
  const kind = readDrizzleEntityKind(client);
  if (kind !== undefined && NON_INTERACTIVE_ENTITY_KINDS.has(kind)) {
    throw new UnsupportedDriverError(kind);
  }
}
