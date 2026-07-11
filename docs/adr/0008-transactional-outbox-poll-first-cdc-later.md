# Transactional outbox: producer in-engine, relay engine-independent, poll-first (CDC opt-in later)

**Status: Proposed (forward-looking; not v1).** Records the design so the reasoning isn't relitigated when the outbox phase begins. See [session-1.md](../drizzle-tx/session-1.md) (Massive #3) and [BACKLOG.md](../BACKLOG.md).

`@drizzle-tx/core` will fold in a transactional outbox as an optional surface behind a `@drizzle-tx/core/outbox` subpath, split into two halves that communicate **only through the outbox table** (the table schema is the seam):

- **Producer** (`enqueue(event)`) — engine-resident, ALS-aware. Inserts an event row through the ambient **transactional client**, so it commits/rolls back atomically with the business writes. This is the transactional half and the *reason the feature belongs in this library specifically*: the outbox insert inherits atomicity from the propagation engine we already ship — it is "just another write on the injected client" inside a `@Transactional` method.
- **Relay** (`drainOnce()` + a thin `startRelay()` loop wrapper) — engine-**independent**. Claims unpublished rows, publishes them to a caller-supplied broker, marks them done. Takes a base client + a `publish` function + a batch bound; **forbidden from importing the transaction manager or ALS.**

The default dispatch mechanism is a **polling relay using `SELECT … FOR UPDATE SKIP LOCKED`**. CDC / logical replication is a deliberately deferred *opt-in* alternative, not the default.

## Why this shape

- **The producer is atomic for free.** Both worlds problem (DB write + broker publish can't be one atomic unit) is converted into "DB write + DB write," which Postgres already makes atomic. The `enqueue` insert rides the exact ALS mechanism as every other write via the [transactional-client](../../packages/core/src/transactional-client.ts) proxy.
- **`drainOnce()` is the unit, not the loop.** One poll-claim-publish-mark pass. The three deployment modes all compose it with zero refactor:
  - **In-process** (always-on server): `startRelay()` = `while (true) { await drainOnce(); await sleep(); }`.
  - **Out-of-process** (dedicated worker): import `drainOnce` into a separate entrypoint.
  - **Serverless single-shot** (Vercel Cron / EventBridge + Lambda / `pg_cron`): call `drainOnce()` once, drain a bounded batch, exit. Overlapping invocations are safe *for free* because `SKIP LOCKED` makes them non-conflicting.
- **"In the package" ≠ "in the engine" ≠ "in-process."** The subpath keeps the outbox out of the main entry's dependency graph; the engine-independent relay keeps the out-of-process/serverless door open at no cost. Import rule is **asymmetric**: producer → engine is allowed (it's the transactional half); relay → engine is forbidden (guarded the way core already guards "never import `@nestjs/*`", ADR-0001).

## Decisions (with the research synthesis)

Authority tiers below: **[A]** official docs/source/maintainer · **[B]** named-expert write-up · **[C]** general blog. Sources verified 2026-07-12.

### 1. Default dispatch = polling with `SELECT … FOR UPDATE SKIP LOCKED`

The only design that is portable everywhere with **zero database feature-gating** — no `wal_level=logical`, no replication slots, no Kafka Connect — and it degrades naturally to the serverless single-shot drain. `SKIP LOCKED` is Postgres's sanctioned queue-access primitive: the docs describe it as being "used to avoid lock contention with multiple consumers accessing a queue-like table." Chris Richardson formalizes this as the *Polling Publisher* pattern.

- **[A]** PostgreSQL — SELECT / locking clause: https://www.postgresql.org/docs/current/sql-select.html
- **[A]** microservices.io — Polling Publisher: https://microservices.io/patterns/data/polling-publisher.html
- **[A]** microservices.io — Transactional Outbox: https://microservices.io/patterns/data/transactional-outbox.html

Accepted downside: latency floored at the poll interval (and up to ~a minute on minute-granularity serverless cron — exact numbers are provider/version-dependent, do not hard-quote); continuous read load on the OLTP DB; needs a partial index (below) to stay bounded as history grows.

### 2. CDC / logical replication is opt-in, deferred — not the default

CDC (Debezium Outbox Event Router / WAL tailing) gives near-real-time latency and zero polling load, and reads the WAL in **commit order** (sidestepping the ordering hazard in §4). But it is feature-gated and ops-heavy: needs `wal_level=logical` + replication slots (+ classically Kafka Connect), a lagging slot can pin WAL and fill the disk, and managed-Postgres support is uneven — RDS/Aurora and Neon support it (off by default, needs a flag/reboot); PlanetScale-classic is MySQL, so Postgres logical replication does not apply. Imposing that on someone who just wants `enqueue()` to work is the wrong default.

The seam makes CDC a later drop-in: it becomes an alternative *listener* behind the **same table contract and same `publish` interface** — nothing in the producer or schema changes. This mirrors the one mature Node/TS lib in this space, `pg-transactional-outbox`, which ships **both** a polling listener (no special settings) and a logical-replication listener (opt-in).

- **[A]** Debezium — Outbox Event Router: https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html
- **[A]** `Zehelein/pg-transactional-outbox` (dual listener; at-least-once): https://github.com/Zehelein/pg-transactional-outbox
- **[A]** AWS Aurora PostgreSQL logical replication: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.html
- **[A]** Neon logical replication: https://neon.com/docs/guides/logical-replication-rds-to-neon

### 3. Delivery guarantee = at-least-once + idempotent/deduplicating consumers. **Never advertise exactly-once.**

Exactly-once end-to-end is not achievable in the general case — the publish→mark-processed step is not atomic with the broker ack, so a crash after a successful publish but before marking re-publishes on restart. Tier-A consensus (microservices.io, Debezium, pg-transactional-outbox all promise at-least-once). Every event carries a stable UUID `id` as the consumer's dedup handle; "effectively once" is achieved at the *consumer* (inbox/dedup table keyed by id), not on the wire. A consumer-side inbox/dedup helper is a possible later add (pg-transactional-outbox ships one), flagged not committed.

- **[A]** microservices.io (at-least-once + idempotent consumer, verbatim) · **[A]** Debezium (log-based delivery is at-least-once) · **[A]** pg-transactional-outbox README.

### 4. Ordering = best-effort per-aggregate; **no global order.** Claim by status, never by an `id > cursor` high-water mark.

**The commit-order vs insert-order hazard is load-bearing.** A row's `seq`/`id` is assigned at INSERT time, but the row only becomes visible at COMMIT time; concurrent transactions commit out of id-order, so a row with a *lower* id can appear *after* a higher one. A relay that remembers "processed up to id N, give me `id > N`" will **silently skip** the late-committing lower id — a permanently lost event. Timestamps have the identical defect. Therefore the relay claims **any row where `processed_at IS NULL`** via `SKIP LOCKED`, never a monotonic cursor.

`SKIP LOCKED` with multiple concurrent relays also breaks *global* ordering by design (each worker skips what others hold, so publish interleaves). Strict per-aggregate order is preserved only by a single relay **or** by sharding on `aggregate_id`; we expose `aggregate_id` as the routing/partition key (Debezium uses it as the Kafka message key for exactly this) and document the guarantee honestly.

- **[A]** PostgreSQL SELECT docs ("inconsistent view") · **[B]** Decodable / Gunnar Morling (ex-Debezium lead), "Revisiting the Outbox Pattern" — missed-message risk from parallel transactions: https://www.decodable.co/blog/revisiting-the-outbox-pattern · **[A]** Debezium (`aggregateid` = message key).

### 5. Publish outside any DB transaction (claim → mark-inflight → publish → mark-done)

Never hold the row lock across the broker round-trip: a slow/hung broker would tie up a Postgres connection for its whole duration and risk pool exhaustion — the exact footgun [ADR-0002](0002-requires-new-needs-pool-and-can-deadlock.md) already warns about. The relay uses two short transactions with the publish in the gap; the crash window between publish and mark-done is precisely what makes delivery *at-least-once* (§3), which is why that's the honest promise rather than a bug. The relay uses raw Drizzle `db.transaction()` for its own short transactions — it does **not** use the ALS-scoped `withTransaction`, reinforcing that relay → engine is forbidden (§Why this shape).

### 6. Table schema = a superset of Debezium's expected columns

```
id            uuid  primary key        -- dedup key / message id  (Debezium: id)
aggregate_type text not null           -- routing               (Debezium: aggregatetype)
aggregate_id  text not null            -- ordering/partition key (Debezium: aggregateid)
event_type    text not null           -- consumer filtering     (Debezium: type)
payload       jsonb not null           --                        (Debezium: payload)
headers       jsonb                    -- optional metadata
seq           bigserial                -- intra-aggregate ordering
created_at    timestamptz not null default now()
processed_at  timestamptz              -- NULL = pending
attempts      int  not null default 0
last_error    text
```

with `CREATE INDEX outbox_pending_idx ON outbox (created_at) WHERE processed_at IS NULL;` — a **partial index** so the index stays bounded to *pending* rows regardless of total history. Default purge strategy is the status column (`processed_at`), simplest and keeps history; **range-partition by `created_at` + `DROP PARTITION`** is documented as the high-throughput escape hatch (status-column churn produces dead tuples → bloat at high write rates). Using a superset of Debezium's five Tier-A columns means a user can later point Debezium at the same table with minimal renaming.

- **[A]** Debezium Outbox Event Router (the five columns are Tier-A). Bookkeeping columns, purge tradeoffs, and the partial-index rationale are reputable-practitioner-sourced (**[C]** msdousti "PostgreSQL + Outbox Pattern Revamped", tiarebalbi "Outbox is a Ledger, Not a Queue"), **not** spec — flagged as such.

## Consequences / constraints

- Optional peer deps only: the relay's broker binding is a caller-supplied `publish(events) => Promise<void>` interface (core ships an in-memory/console publisher for tests only). No broker enters core's dependency graph unless the consumer wires one. Core stays zero-*required*-dependency; the subpath keeps it dead-code-free when unused; dual ESM+CJS + `publint`/`attw` stay green for the new subpath.
- Guarantees are documented honestly in the repo's existing style (cf. the no-2PC boundary in BACKLOG.md item H, the connection-hold caveat in ADR-0002): **at-least-once**, **per-aggregate best-effort ordering (strict only single-relay or sharded), no global order**, publish-outside-transaction.
- Tunables (batch size, poll interval, backoff) are exposed as options with sane defaults, **not** prescribed — no authoritative figures exist; practitioner values cluster around batches of 100–1000 and intervals of ~100ms–5s (all **[C]**, treat as tunables).

## Rejected alternatives

- **CDC / logical replication as the default.** Rejected: feature-gated (`wal_level=logical`, slots), ops-heavy (slot/WAL disk-bloat risk), and unavailable-by-default on the managed Postgres our target users run. Deferred to an opt-in listener behind the same seam.
- **Advertise exactly-once.** Rejected: not achievable across a DB and an arbitrary broker; the honest, universally-agreed contract is at-least-once + consumer dedup.
- **Relay cursor via `WHERE id > last_seen` / `ORDER BY created_at`.** Rejected: the commit-order-vs-insert-order hazard (§4) silently drops late-committing lower ids. Claim-by-`processed_at IS NULL` + `SKIP LOCKED` instead.
- **Hold the row lock across the broker publish** (single-transaction claim-lock-publish-mark). Rejected: ties a DB connection up for the broker round-trip → pool-exhaustion risk (ADR-0002).
- **Relay imports the transaction manager / ALS for convenience.** Rejected: couples the engine-independent half to the engine and breaks the out-of-process/serverless story. Relay uses raw Drizzle transactions on the base client.
- **A separate companion package (`@drizzle-tx/outbox`).** Rejected in favor of folding into core behind a subpath + optional peer deps (decided 2026-07-11) — the producer's whole value is inheriting the engine's ambient transaction, so it belongs with the engine; the subpath preserves isolation without a second published package.

## Evidence (independently verified, primary sources)

Postgres `SKIP LOCKED` wording; microservices.io at-least-once / idempotent-consumer contract and Polling Publisher downsides; Debezium Outbox Event Router column schema and routing key; `Zehelein/pg-transactional-outbox` dual-listener architecture + at-least-once; AWS/Neon managed logical-replication support; Decodable/Morling on the commit-order missed-message hazard. Thin/flagged: serverless single-shot-drain has no Tier-A "outbox" spec (assembled from generic cron docs + `SKIP LOCKED` semantics); batch/interval numbers and purge/index tradeoffs are practitioner-sourced, not spec.
