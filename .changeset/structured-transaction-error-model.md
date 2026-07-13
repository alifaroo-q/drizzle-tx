---
"@drizzle-tx/core": minor
---

Structured transaction-failure error model (ADR-0012).

`DrizzleTxError` is now a richer discriminated union. Transaction-body failures
(`SerializationFailure`, `DeadlockDetected`, `ConnectionLost`, `TransactionAborted`)
carry `TxFailureFields` — `{ message, sqlState, cause }` — and are classified
structurally from the pg SQLSTATE / socket markers, walking Drizzle's
`DrizzleQueryError` `.cause` chain so a wrapped driver error is still classified
by the underlying pg code. A rollback double-fault preserves the swallowed domain
error as `lostDomainError` (ADR-0012 §2). A `COMMIT` that fails (deferred
constraint / serialization at commit) now surfaces as the classified variant even
when the work returned `ok(...)` (ADR-0012 §1, R1).

BREAKING (pre-1.0 minor): consumers that matched on the previous flat
`DrizzleTxError` shape must switch to the new variants. Use `matchError(err, { ... })`
for an exhaustive, compile-checked handler map (e.g. mapping to an HTTP status).
