---
"@drizzle-tx/nestjs": minor
---

`TransactionHost` tracks the core two-primitive + error-model work.

- `begin()` accepts `BeginOptions` (incl. `disposeTimeoutMs`), forwarded to core —
  full parity with the scope leak-backstop.
- `withTransaction` is now bound from core's exported `WithTransaction<TClient>`
  contract instead of a hand-redeclared overload set + cast, so the
  `REQUIRES_NEW` `Independent` overloads are preserved and can't drift from core.
- Re-exports `settle` and `Independent` (needed to consume a `REQUIRES_NEW`
  outcome); `assertNever` is no longer re-exported (use `matchError`).

BREAKING (pre-1.0 minor): `TransactionHost.isActive()` is renamed to
`isTransactionActive()`. Update call sites accordingly.
