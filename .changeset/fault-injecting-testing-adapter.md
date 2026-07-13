---
"@drizzle-tx/core": minor
---

Add `FaultInjectingDrizzleAdapter` and pg error-shape helpers to
`@drizzle-tx/core/testing` (#28).

The adapter injects faults at any transaction phase (`begin`/`commit`/`rollback`
and the savepoint phases), sticky or one-shot (`failOn`/`failOnce`, or a
constructor `failAt` map), and records a boundary log — so you can exercise the
rollback-boundary classification (serialization/deadlock/connection-lost, R2
shadowing, nested savepoints) without a database. Ships with `fakePgError`,
`socketError`, and `pgSerializationFailure`/`pgDeadlock`/`pgAdminShutdown`
helpers that carry the exact structural markers `classifyCaught` reads.

Additive; this surface is stable but test-only (see STABILITY.md).
