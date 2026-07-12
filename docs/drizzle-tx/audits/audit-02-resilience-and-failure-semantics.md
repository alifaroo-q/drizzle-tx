# Audit 02 — Resilience & failure semantics

**Ticket:** [#21](https://github.com/alifaroo-q/drizzle-tx/issues/21) (wayfinder:research) · **Map:** [#19](https://github.com/alifaroo-q/drizzle-tx/issues/19) · **Date:** 2026-07-12

**Scope reviewed:** the transaction-boundary error path across `packages/core/src` (`transaction-manager.ts`, `rollback-boundary.ts`, `transaction-scope.ts`, `adapters/drizzle.ts`, `errors.ts`) and the failure coverage in `packages/core/test/{unit,integration}`. Skills: `diagnosing-bugs`, `domain-modeling`.

**Framing (load-bearing):** core **never manages raw connections**. It delegates BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE / acquire / release entirely to drizzle's `.transaction()` callback (`adapters/drizzle.ts` — `grep` confirms core has zero `connect()` / `release()` / `.end()`). Core's *only* failure job is to **classify** whatever throws out of `.transaction()` into a `DrizzleTxError` (`classifyRollback`), and to bridge domain `err(E)` through drizzle's throw-to-rollback path (`toThrowable` → `RollbackSignal`). So most "did we release the connection?" questions reduce to "does drizzle release?" (yes, for its callback API) — the **only** connection-lifecycle surface core *adds* is the `begin()`/`await using` scope, which deliberately holds a connection open across a block (see R5).

**Verdict in one line:** Failure *handling* is structurally sound — every throw is caught and classified, nothing rethrows, default-deny holds. The gaps are (a) **`TransactionAborted` is an under-resolved catch-all** (converges with Audit-01 G2), (b) **two real failure paths are untested and their contracts undocumented** (COMMIT-fails-after-ok-work; domain-`E`-lost-if-ROLLBACK-fails), and (c) **the scope API can leak a connection if never disposed**, with no backstop.

---

## Part 1 — Failure-mode inventory (handled / tested / modeled)

| # | Failure mode | Handled? | Tested? | Modeled as | Notes |
|---|---|---|---|---|---|
| 1 | Work callback throws (non-Result) | ✅ catch → `classifyRollback` | ✅ unit "wraps an unexpected throw as TransactionAborted" | `TransactionAborted{cause}` | never rethrows — verified |
| 2 | Work returns `err(E)` (domain rollback) | ✅ `toThrowable`→`RollbackSignal`→rollback→unwrap | ✅ unit + integration (drizzle "row ABSENT", NESTED, REQUIRED join) | passthrough `E` (not folded) | happy path only — see #5 |
| 3 | BEGIN fails (can't start tx) | ✅ reject → classify | ⚠️ only via fake reject in `begin()` unit test; no generic integration | `TransactionAborted` / `PoolConnectionTimeout` | same code path as #1 → low risk |
| 4 | **COMMIT fails** (deferred constraint, serializable-at-commit) | ✅ structurally (reject → classify) | ❌ **no test** | `TransactionAborted` | **ok-work can still yield err — contract undocumented → R1** |
| 5 | **ROLLBACK fails** (conn dead during rollback) | ⚠️ classified, but **domain `E` is lost** | ❌ **no test** | `TransactionAborted{cause: rollbackErr}` | RollbackSignal supplanted by the rollback error → **passthrough hole → R2** |
| 6 | Savepoint create/release fails (NESTED) | ✅ classify | ⚠️ savepoint *rollback* tested; *failure* not | `TransactionAborted` | low-med → R6 |
| 7 | Connection lost mid-tx | ✅ classify | ❌ no test (needs fault injection) | `TransactionAborted` (generic) | indistinguishable from "your code threw" → R3 |
| 8 | Pool exhaustion via REQUIRES_NEW (ADR-0002) | ✅ fail-fast → `PoolTimeoutError` | ⚠️ **weak assertion** (accepts *either* kind) | `PoolConnectionTimeout{timeoutMs}` | `timeoutMs` **always `undefined`** → R4 |
| 9 | `begin()`/`await using` dispose failure | ✅ dispose never throws; warn on settle-failure | ✅ scope unit (commit-failed warns; pre-capture errors) | logger.warn (by design, not Result) | silent to caller by design — documented tradeoff |
| 10 | Double-rollback / rollback-after-commit | ✅ last-write-wins | ✅ unit "rollback() after commit() wins" | — | covered |
| 11 | RollbackSignal leaking past its boundary | ✅ caught at same boundary; no escape path found | ⚠️ implicit only (no explicit leak test) | — | see footgun in Part 3 |
| 12 | `HostNotInitialized` | produced **only in nestjs**, never in core | ✅ in nestjs suite | core union variant, core-unreachable | shared taxonomy — fine, noted |

---

## Part 2 — Error-taxonomy completeness

The union has 4 variants: `PoolConnectionTimeout`, `TransactionAborted`, `HostNotInitialized`, `NotPoolBacked`.

- **Correctly discriminated** — no overlap; `matchError` + `assertNever` make it exhaustive and compile-caught (Audit-01 affirmed this). Adding a variant is a compile-caught breaking change.
- **But `TransactionAborted{cause: unknown}` is a catch-all** — modes #1, #3, #4, #5, #6, #7 *all* land here. The taxonomy is "complete" only trivially (everything that isn't a pool timeout falls into the sink). The real question is which failures **deserve their own variant** for the roadmap:
  - **Serialization failure `40001` / deadlock `40P01`** — retry (roadmap "Do Now") *must* distinguish these; today buried in `cause: unknown`.
  - **Connection-lost vs. your-code-threw** — a consumer cannot tell "retryable infra" from "a bug in my work function"; both are `TransactionAborted`.
  - **COMMIT-failed-after-ok-work** — semantically distinct from "work threw" but the same variant.
  - This is the **same finding as Audit-01 G2**, reached from the failure-semantics side. **Resolve them together.** → R3.
- **Domain-error passthrough** (ADR-0003) is honored on the happy rollback path (`RollbackSignal` → `err(payload)`) but **not guaranteed if the ROLLBACK itself fails** (mode #5). That is the one genuine passthrough hole. → R2.

---

## Part 3 — Cleanup / default-deny guarantees

- **Connection release:** fully delegated to drizzle's callback API; core adds no leak surface **except** the scope. → R5.
- **Scope default-deny under dispose ordering:** well tested — no-commit → rollback, rollback-after-commit → rollback, early-return → rollback, commit-then-dispose → commit. Solid.
- **Partial-commit windows:** the REQUIRES_NEW inner-commits-while-outer-rolls-back window is **by design** (independent tx, ADR-0002) and is tested ("REQUIRES_NEW inner COMMITS even when the outer rolls back"). NESTED correctly scopes to the savepoint. No *unintended* partial-commit window found.
- **The REQUIRES_NEW / nested return footgun:** returning an inner `err` *directly* from outer work re-throws a fresh `RollbackSignal` and rolls the **outer** back — the tests document this ("must wrap inner in ok()"). No signal *leak*, but a sharp ergonomics edge — handed to Audit-02/ergonomics (#22), not a resilience defect.
- **Double-dispose:** `releaseGate()` twice is a no-op on the gate, but the warn branch could re-run on a genuine settle-failure (double-warn). Minor; untested.

---

## Gap-list — candidate decision-tickets (feed the synthesis step)

Ranked by roadmap urgency. Held un-ticketed pending synthesis (R3 converges with Audit-01 G2; R6 belongs to the coverage audit #23).

- **R1 — COMMIT-failure path is untested and its contract is undocumented. (Medium · decision + test)**
  A work function that returns `ok(value)` can still resolve to `err(TransactionAborted)` when COMMIT fails (deferred constraints, serializable conflict surfaced at commit). Decide + document the "ok-work may still err at commit" contract, and add a real-Postgres deferred-constraint commit-failure integration test.

- **R2 — Domain-error passthrough is lost when ROLLBACK fails. (Medium · decision)**
  On `err(E)`, a `RollbackSignal` triggers rollback; if the ROLLBACK then throws, `classifyRollback` sees the rollback error (not the signal) and returns `TransactionAborted{cause: rollbackErr}` — the consumer's `E` is swallowed. Decide whether infra-failure-trumps-domain is the intended contract (likely yes) and document it, or preserve `E` alongside the infra cause. Untested.

- **R3 — `TransactionAborted` is an under-resolved catch-all. (Medium · decision · CONVERGES with Audit-01 G2)**
  Connection-loss, `40001`, `40P01`, COMMIT-failure, and "your code threw" all fold into one variant. Correctly discriminated but too coarse for retry and for consumer triage. Decide: add variants (`SerializationFailure` / `DeadlockDetected` / `ConnectionLost`) vs. a structured `cause` carrying SQLSTATE (without importing `pg` into core — the constraint `isPoolTimeoutError` already respects). **Resolve as one decision with G2.**

- **R4 — Weak pool-exhaustion assertion + always-`undefined` `timeoutMs`. (Low-med · cheap in-place fix)**
  The ADR-0002 fail-fast test accepts *either* `PoolConnectionTimeout` *or* `TransactionAborted`, so a classification regression wouldn't fail it — tighten it to require `PoolConnectionTimeout`. And the adapter always throws `new PoolTimeoutError(undefined)`, so the modeled `timeoutMs` is dead — either populate it from the pool's `connectionTimeoutMillis` or drop the field.

- **R5 — The scope API can leak a connection if never disposed. (Medium · decision)**
  `begin()` holds the connection open via the gate until dispose. `await using` guarantees disposal, but a manually-held scope that is never disposed pins the connection indefinitely — there is no gate timeout or finalizer backstop (the ADR-0002 caveat covers pool-*sizing*, not forgotten-dispose). Decide: add a safety timeout on the gate, and/or elevate the "must dispose" contract to a load-bearing, documented invariant.

- **R6 — Untested real-Postgres failure modes. (Low · hand to coverage audit #23)**
  Savepoint create/release failure, connection-loss mid-tx, generic BEGIN failure, double-dispose, explicit RollbackSignal-containment. All route through the same classify path (low regression risk), none exercised. Overlaps #23's remit — flag the seam rather than duplicating.

## Affirmations (things that are right)

- Nothing rethrows — every boundary catch resolves to a `Result`. The no-throw model (ADR-0003) holds at runtime.
- Default-deny rollback + last-write-wins dispose ordering are correct and well tested.
- The taxonomy is correctly discriminated and exhaustively matched (compile-caught).
- Connection lifecycle is soundly delegated to drizzle; core adds no leak surface except the deliberate scope gate (R5).
- The REQUIRES_NEW partial-commit window is intentional, documented, and tested — not a defect.
