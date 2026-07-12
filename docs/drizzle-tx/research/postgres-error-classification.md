# Research: Postgres / node-postgres / drizzle-orm error classification

Primary-source findings backing [ADR-0012](../../adr/0012-structured-transaction-failure-error-model.md) (structured transaction-failure error model, issue #27). Gathered 2026-07-12; drizzle facts re-verified against the pinned `drizzle-orm@1.0.0-rc.4` in this repo's `node_modules`.

## 1. PostgreSQL SQLSTATE codes (Appendix A)

Classes = first 2 chars.

**Class 40 — Transaction Rollback**
| Code | Condition |
|---|---|
| `40000` | `transaction_rollback` |
| `40002` | `transaction_integrity_constraint_violation` |
| **`40001`** | **`serialization_failure`** — the retryable one under SERIALIZABLE / REPEATABLE READ |
| `40003` | `statement_completion_unknown` |
| **`40P01`** | **`deadlock_detected`** — retryable |

**Class 08 — Connection Exception**
| Code | Condition |
|---|---|
| `08000` | `connection_exception` |
| `08003` | `connection_does_not_exist` |
| `08006` | `connection_failure` |
| `08001` | `sqlclient_unable_to_establish_sqlconnection` |
| `08004` | `sqlserver_rejected_establishment_of_sqlconnection` |
| `08007` | `transaction_resolution_unknown` |
| `08P01` | `protocol_violation` (arguably a driver/client bug, but connection is unusable) |

**Class 57 — Operator Intervention**
| Code | Condition | Connection-gone? |
|---|---|---|
| `57000` | `operator_intervention` | no |
| `57014` | `query_canceled` | no (cancel/statement_timeout) |
| `57P01` | `admin_shutdown` (e.g. `pg_terminate_backend`) | **yes** |
| `57P02` | `crash_shutdown` | **yes** |
| `57P03` | `cannot_connect_now` (starting up / recovery — transient) | **yes** |
| `57P04` | `database_dropped` | **yes** |
| `57P05` | `idle_session_timeout` | **yes** |

"Backend went away — infra, not a code bug" = **Class 08 wholesale** + **`57P01`–`57P05`**. `57014`/`57000` are cancellation, not connection loss.

## 2. node-postgres error shape

A query error is a **`DatabaseError extends Error`** (pg-protocol `messages.ts`) populated from the backend `ErrorResponse`:
- **`.code`** = the 5-char SQLSTATE, typed **`string | undefined`** (e.g. `err.code === '40001'`). String, not number.
- Also carries `.severity`, `.detail`, `.hint`, `.position`, `.where`, `.schema`, `.table`, `.column`, `.constraint`, `.file`, `.line`, **`.routine`** — all `string | undefined`.

## 3. `.code` on COMMIT and SAVEPOINT/ROLLBACK failures — YES

pg does not special-case the statement. Every backend `ErrorResponse` — from `SELECT`, `COMMIT`, `SAVEPOINT`, `RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT` — parses through the same path into a `DatabaseError` with `.code`. So a COMMIT failing on a deferred-constraint violation, or a `40001` surfacing at COMMIT under SERIALIZABLE, throws a `DatabaseError` carrying its SQLSTATE. Holds **when the failure is server-reported**; a COMMIT/ROLLBACK failing because the connection dropped gives the code-less error in §4 instead.

## 4. Connection-loss error shape — two variants

- **(A) Server-initiated → SQLSTATE error (has `.code`)** — backend sends `ErrorResponse` as it closes (`57P01`, Class 08). Normal `DatabaseError`.
- **(B) Client-side socket loss → code-less plain `Error` (no SQLSTATE)** — pg constructs `new Error('Connection terminated unexpectedly')` (stream ended mid-query) or `new Error('Connection terminated')` (we were closing). Raw TCP errors pass through as Node errors with a **libuv `.code`** (`ECONNRESET`/`EPIPE`/`ETIMEDOUT`/`ENOTFOUND`/`ECONNREFUSED`) and `.syscall`/`.errno`.
- **Discriminator:** SQLSTATE ⇔ `err.code` is a 5-char SQLSTATE (recognize structurally via accompanying `.severity`/`.routine`, or the SQLSTATE grammar). Everything else — undefined `.code`, a libuv `E*` code with `.syscall`, or the "Connection terminated" messages — is client/infra connection loss. **Check socket-loss first** (a libuv `EPIPE` is 5 chars and would otherwise look like a SQLSTATE).

## 5. drizzle-orm pg transaction rollback behavior

`drizzle-orm/node-postgres/session` — **verified against pinned rc.4 locally** (matches `main`):

Top-level `transaction()`:
```js
await tx.execute(sql`begin ...`);
try {
  const result = await transaction(tx);
  await tx.execute(sql`commit`);      // COMMIT is INSIDE the try → its failure is caught & re-thrown (R1)
  return result;
} catch (error) {
  await tx.execute(sql`rollback`);    // NOT in its own try/catch
  throw error;                         // reached ONLY if rollback succeeded
}
```
- (a) On the happy rollback path drizzle **re-throws the ORIGINAL** callback error — a thrown sentinel (our `RollbackSignal`) survives intact.
- (b) The `ROLLBACK` is **unprotected**: if it throws (connection gone), it **shadows** the original error — `throw error` never runs. No `AggregateError`, no `error.cause`. → **R2**: the domain `E` is lost unless we stash it before entering drizzle.

Savepoint / nested path is identical (`rollback to savepoint`, unprotected).

## Sources
- PostgreSQL Error Codes (Appendix A): https://www.postgresql.org/docs/current/errcodes-appendix.html
- node-postgres `DatabaseError` (pg-protocol): https://github.com/brianc/node-postgres/blob/master/packages/pg-protocol/src/messages.ts
- node-postgres `Client` (connection-loss errors): https://github.com/brianc/node-postgres/blob/master/packages/pg/lib/client.js
- node-postgres issue #3107 (Connection terminated unexpectedly): https://github.com/brianc/node-postgres/issues/3107
- drizzle-orm node-postgres session/transaction: https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/node-postgres/session.ts (+ local `node_modules/.pnpm/drizzle-orm@1.0.0-rc.4.../node-postgres/session.js`)
