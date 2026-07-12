# The driver-capability gate throws at assembly, outside the `Result` model

**Status: Accepted.** Crystallizes the *mechanism* for [ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md) Decision 1 ("driver capability is a hard gate — detect and fail clearly, not mysteriously"). Realized by `createDrizzleTx` (issue #11).

## Context

`createDrizzleTx({ drizzle })` is the single non-DI assembly path ([CONTEXT.md](../../CONTEXT.md) → **Assembly**). A `drizzle-orm/neon-http` client structurally satisfies core's `DrizzleTxCapable` (it *has* a `.transaction()` method) but drizzle throws `Error("No transactions support in neon-http driver")` — a bare, internal throw at the *first* transaction, i.e. at request time, not boot. That is precisely the "fails mysteriously later" ADR-0009 forbids.

## Decision

1. **Throw at construction, not a lazy `Result`.** `createDrizzleTx` detects the incapable driver and `throw`s synchronously. This does **not** violate the never-throw invariant ([ADR-0003](0003-explicit-result-pattern-no-throw.md)): that invariant governs the *runtime fallible surface* (`withTransaction`/`begin` returning `Result<T, E>`). A driver that cannot host *any* interactive transaction is a boot-time programmer misconfiguration — like passing `null` — not a modeled runtime condition. A `Result`-returning factory was rejected: it destroys the module-singleton ergonomics (`export const { db } = …`) and forces `if (!res.ok) throw` into every app's `db.ts`.

2. **Detect via a drizzle `entityKind` denylist, at construction.** The pure detector reads `Symbol.for("drizzle:entityKind")` off the instance's prototype chain (a global-registry symbol — **no `drizzle-orm` import**, honoring core's optional-peer stance) and rejects a small, extensible set of *known non-interactive* kinds — today `{ "NeonHttpDatabase" }`.
   - **Denylist, not allowlist:** unknown/custom/hand-rolled `DrizzleTxCapable` clients and the testing `NoOpDrizzleAdapter` client carry no `entityKind` and must pass; and new interactive drivers (postgres-js, better-sqlite3, …) must not require a gate edit. Only the rare *non-interactive* driver is enumerated. Accepted gap: a future non-interactive driver we haven't listed slips through until added.
   - **Not `isPoolBacked`:** that check is too broad — a single `pg.Client` (`NodePgDatabase`, not a Pool) *can* do `REQUIRED`/`NESTED` interactive tx and is correctly allowed (only `REQUIRES_NEW` lazily `err(NotPoolBacked)`s). The gate targets "cannot host *any* interactive tx", a strictly narrower set.

3. **Throw a dedicated `UnsupportedDriverError`, not a new `DrizzleTxError` variant.** The condition is thrown once at boot and can never arrive as a runtime `err(...)`. Adding it to the `DrizzleTxError` union would force every consumer's exhaustive `matchError`/`switch` to handle a variant unreachable at runtime. The dedicated class stays *typed* (carries the offending `driver` entityKind) without polluting the runtime union.

4. **The gate lives at the factory choke point**, not in `DrizzleAdapter`'s constructor — keeping the adapter's "never throws" contract intact. `createDrizzleTx` is the one sanctioned assembly path (the NestJS module delegates to it); hand-wiring `new DrizzleAdapter(...)` is unsupported and ungated by design.

## Consequences

- Detection is a pure, DB-free module ([ADR-0006](0006-functional-core-imperative-shell.md) functional core) — unit-tested by passing `{ [Symbol.for("drizzle:entityKind")]: "NeonHttpDatabase" }`.
- The driver matrix (ADR-0009) is documented alongside the factory (JSDoc + README): `pg.Pool` ✅ / Neon **WebSocket** ✅ / Neon **HTTP** ❌ / PgBouncer txn-mode ⚠️.
- Extending support is additive: a new interactive driver needs nothing; a new *non-interactive* one adds one string to the denylist.
