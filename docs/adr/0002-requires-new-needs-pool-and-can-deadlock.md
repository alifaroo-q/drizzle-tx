# `REQUIRES_NEW` requires a Pool-backed db and can deadlock a bounded pool

`Propagation.REQUIRES_NEW` starts a genuinely independent top-level transaction by calling `db.transaction()` on the **base** Drizzle instance, which draws a *fresh* connection from the `pg` pool while the parent transaction still holds its own. We accept this design (it is the only way to get true independence on Postgres, where one connection can host only one top-level transaction) and treat its failure mode as a documented, bounded constraint rather than trying to prevent it in the engine.

## Consequences / constraints

- The base `db` **must be `Pool`-backed**. A single `pg.Client` cannot host two independent top-level transactions, so `REQUIRES_NEW` is impossible on one.
- Pool `max` **must exceed the deepest concurrent `REQUIRES_NEW` nesting depth**, or `pool.connect()` blocks on a connection that will never be released (the parent is waiting on the child) → deadlock. This is an emergent property of ALS + a bounded pool, invisible in the API, so it is documented loudly.
- Consumers should set a finite `connectionTimeoutMillis`; node-postgres defaults to `0` ("wait forever"), which turns exhaustion into an indefinite hang. The library maps an acquisition timeout to a clear, actionable error and ships a test asserting a `max: 1` pool + nested `REQUIRES_NEW` **fails fast rather than hanging**.

## Rejected alternative

Runtime nesting-depth-vs-pool-size detection that throws *before* acquiring — rejected for v1: the pool's live free-count isn't reliably knowable ahead of concurrent acquisition, and fail-fast via `connectionTimeoutMillis` + a descriptive error achieves the same "don't hang" guarantee without brittle bookkeeping. Revisit if real usage shows the error is too opaque.

Evidence: node-postgres pool docs and the documented connection-pool-exhaustion deadlock pattern (brianc/node-postgres#2613).
