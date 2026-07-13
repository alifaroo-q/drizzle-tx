---
"@drizzle-tx/core": minor
---

Two-primitive split: `Independent` outcomes for `REQUIRES_NEW` + opt-in scope
leak backstop (ADR-0014, #31).

- `REQUIRES_NEW` now returns an `Independent<T, E>` — a settled outcome on its OWN
  connection that you inspect (`.ok`/`.value`/`.error`) rather than `return` from
  the outer work. `return inner` is a compile error; `return settle(inner)`
  consciously propagates the inner outcome as the outer's. New exports: the
  `Independent<T,E>` type and `settle()` (runtime identity, zero cost).
- `begin()` scopes gain an opt-in `disposeTimeoutMs` leak backstop (per-call or a
  `TransactionManager`/`createDrizzleTx` default). Default OFF; when set, a scope
  that is never disposed is reclaimed — forced rollback + release + a loud warn.
  Prefer `await using` so disposal is guaranteed and the backstop never fires.

BREAKING (pre-1.0 minor): the `REQUIRES_NEW` overloads now return
`Independent<T, E | DrizzleTxError>` instead of a plain `Result`. Callers that
`return`ed a `REQUIRES_NEW` result directly must wrap it in `settle(...)` (or
`ok(...)` to commit the outer regardless).
