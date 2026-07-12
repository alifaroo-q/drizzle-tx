# Audit 01 — Functional-core purity & seam depth

**Ticket:** [#20](https://github.com/alifaroo-q/drizzle-tx/issues/20) (wayfinder:research) · **Map:** [#19](https://github.com/alifaroo-q/drizzle-tx/issues/19) · **Date:** 2026-07-12

**Scope reviewed:** all of `packages/core/src` (~800 LOC). Lens: ADR-0006 purity boundary + Ousterhout deep-module depth, stress-tested against the session-1 roadmap (multi-driver, hooks, retry, OTel, outbox, full propagation set, replica routing).

**Verdict in one line:** The purity boundary **holds** and the biggest modules (adapter port, ALS context, `TxPlan`, transactional-client proxy) are genuinely deep and well-placed. The core is *not* over-abstracted. The load-bearing gap is a **missing transaction-lifecycle observation seam** — two roadmap capabilities (post-commit hooks, OTel) have *nothing to attach to today* — compounded by an **error/context model too lossy** to feed retry and observability.

---

## Part 1 — Purity boundary (ADR-0006)

**Finding: the boundary holds. No pure module leaks I/O, ALS, logging, or clock.**

| Module | Classification | Leak check |
|---|---|---|
| [`propagation-plan.ts`](../../../packages/core/src/propagation-plan.ts) | pure | ✅ `planTransaction` / `normalizeArgs` / `ignoredIfPresent` are deterministic; no `getStore`, no `console`, no clock/random. `notPoolBacked()` it calls is a pure factory. |
| [`rollback-boundary.ts`](../../../packages/core/src/rollback-boundary.ts) | pure | ✅ `classifyRollback` / `isPoolTimeoutError` pure. **Nuance:** `toThrowable` *throws* by design (the one documented inversion of no-throw). Deterministic control-flow signal, not an I/O leak — acceptable, but it is the one function in the "pure" set that isn't referentially transparent. |
| [`transaction-context.ts`](../../../packages/core/src/transaction-context.ts) | shell (effect) | ✅ thin ALS wrapper, no decision logic. |
| [`transaction-scope.ts`](../../../packages/core/src/transaction-scope.ts) | shell (effect) | ✅ essential complexity (gate/race/default-deny); the only decision inside is the `SCOPE_ROLLBACK`-sentinel vs genuine-failure discrimination, correctly kept at the effect boundary. |
| [`transaction-manager.ts`](../../../packages/core/src/transaction-manager.ts) | shell (coordinator) | ✅ interprets `TxPlan`; reads ALS once. Two small decisions still live here (below) but both are legitimately effect-bound. |

**Two decision-shaped things in the shell — both legitimate, noted for completeness:**

1. `getTransactionClient()` = `#ctx.current() ?? #adapter.getBaseClient()` — the query-time "active-tx-else-base" resolution. It *must* read ALS, so it belongs in the shell; it is not decision logic that should move to the core.
2. `#run`'s `switch (plan.kind)` maps `plan.kind` → the warn-message *string* (`'joining an existing transaction'` / `'a NESTED (savepoint) transaction'`). The *decision to warn* is already pure (`ignoredOptions` presence); only message presentation is in the shell. Fine.

**Conclusion:** ADR-0006 is not aspirational — it is real. No remediation needed on purity. The purity discipline is a strength to *preserve* as the roadmap adds modules (every new decision must land in a pure module, every new effect behind a seam).

---

## Part 2 — Seam-by-seam depth review (Ousterhout)

| Seam | Depth | Location | Minimal? | Verdict |
|---|---|---|---|---|
| **Adapter port** `TransactionAdapter` ([port.ts](../../../packages/core/src/adapters/port.ts)) | **Deep** — `DrizzleAdapter` hides rc.4 construction, structural `isPoolBacked`, pg-timeout translation, CJS/ESM `instanceof` behind 4 members. | Right — single seam for all driver specifics. Correctly resisted shattering into Connector/Savepoint/Committer (ADR-0006). | Mostly — but capability is **one boolean** (see G3). | Deep & correct today; **capability surface too coarse for multi-driver.** |
| **`TransactionContext`** (ALS) | **Deep** — hides store shape + the run()-only / no-`enterWith` rule behind `current`/`isActive`/`run`. | Right. | Yes. | Deep & correct; **carries only `{client}`** (see G4). |
| **`TxPlan`** value type | **Deep-ish** — plain-data description carrying exactly what the shell interprets; `assertNever`-guarded, additive. | Right — the documented seam for new propagation modes. | Yes. | **Designed for exactly the roadmap's propagation growth.** Affirm. |
| **Transactional-client `Proxy`** ([transactional-client.ts](../../../packages/core/src/transactional-client.ts)) | **Deep-ish** — simple interface (`TClient`), hides resolve-per-access + bind-to-real-client. | Right. | Yes (`get`+`has` only). | **This is the load-bearing seam for the outbox producer and safe-mode.** Holds. Minor robustness nuance below. |
| **`DrizzleTxError`** union ([errors.ts](../../../packages/core/src/errors.ts)) | Shallow-by-design (data), `matchError` exhaustive. | Right. | — | **`TransactionAborted{cause: unknown}` erases structure** retry/OTel need (see G2). |
| **`TxLogger`** ([logger.ts](../../../packages/core/src/logger.ts)) | **Shallow** — `warn(string)` only. | It is a *narrow-injection* seam, appropriately shallow for warnings. | — | Fine *as a logger* — but it is **mistaken as the observability seam it cannot be** (see G1). |

**Minor robustness nuances (not gaps, noted for the record):**
- The proxy calls `resolve()` on *every* property access, including probe accesses like `then`/`Symbol.toPrimitive` if the client is ever awaited or coerced. Resolves to the base client harmlessly today, but worth a guard if a future surface awaits `db`.
- `#newTransaction` and `#nested` in the manager are near-identical boundary shells (try → `adapter.wrap` → `#ctx.run(toThrowable(await work()))` → `ok`; catch → `classifyRollback`). Duplication, not impurity — but it means any boundary-level cross-cut (retry, lifecycle hooks) must be threaded through *both* (see G5).

---

## Part 3 — Roadmap stress-test (design-only; which seam bends, which breaks)

Each roadmap capability from `session-1.md` pressed against the seams above. **Holds** = seam absorbs it unchanged · **Bends** = seam is right but its surface must widen · **Breaks** = no seam exists.

| Capability (session-1) | Seam pressed | Result |
|---|---|---|
| **Outbox producer** (Massive #3) | Transactional-client proxy (ALS) | **Holds** ✅ — `enqueue` is "just another write on the injected client"; the proxy is exactly the seam ADR-0008 relies on. Relay is engine-independent by design. |
| **MANDATORY / NEVER** propagation (Medium #4, "Do Next") | `TxPlan` + `planTransaction` | **Holds** ✅ — additive variants; `reject` already exists for MANDATORY-inactive / NEVER-active; compile-caught by `assertNever`. The seam was built for this. |
| **Second driver** postgres.js/Neon → MySQL/SQLite (Massive #2) | Adapter port | **Bends** — `supportsIndependentTransactions` (one boolean) can't say "REQUIRES_NEW yes, savepoints no" (AWS Data API), and `wrapWithTransaction`'s `Promise<T>` assumes async throw-to-rollback (sync SQLite drivers throw synchronously). → **G3**. |
| **Retry on 40001/40P01** (Medium #1, "Do Now") | Manager boundary + error model | **Bends** — the callback-owns-the-unit shape is right (retry is a loop around `#newTransaction`), *but* `TransactionAborted{cause: unknown}` hides the SQLSTATE needed to classify retryable. → **G2** (+ G5 duplication). |
| **SUPPORTS / NOT_SUPPORTED** (full set, "Explore") | `TransactionContext` | **Bends** — suspend/run-outside-tx needs a `TxPlan` `run-bare` variant *and* an ALS `exit`/suspend capability `TransactionContext` doesn't have. Not pressing (the "Do Next" slice is only MANDATORY/NEVER). → **G6**. |
| **Replica routing** (Medium #5) | ALS store shape | **Bends** — needs access-mode (write-tx vs read-only) in the store to pin reads; store is `{client}` only. Narrow audience. → **G4**. |
| **Post-commit hooks** afterCommit/afterRollback (Medium #2, "Do Now") | *(none)* | **BREAKS** — the manager knows commit (`ok`) vs rollback (`catch`) but exposes **no lifecycle seam**. `TxLogger.warn(string)` is not it. → **G1**. |
| **OTel span-per-tx** (Medium #3) | *(none)* | **BREAKS** — same missing lifecycle seam, *plus* it wants savepoint-depth + propagation-mode + retry-count, none of which the ALS store or context tracks. → **G1 + G4**. |

**The two breaks are the same missing thing.** Hooks and OTel both fail for lack of a transaction-lifecycle observation seam. Both are in the roadmap's **"Do Now"** tier. This is the audit's headline.

---

## Gap-list — candidate decision-tickets (feed the synthesis step)

Ranked by roadmap urgency. These graduate to sharp decision-tickets at the map's **Synthesis / prioritization** step (after the sibling audits #21–#24 land), because several will interact (esp. G1↔G4, and whatever the resilience audit surfaces on failure-semantics).

- **G1 — No transaction-lifecycle observation seam. (High · BREAKS · unblocks Hooks + OTel, both "Do Now")**
  Design a structured lifecycle-event seam (begin / commit / rollback / retry / savepoint-enter-exit), logger-style injection per the ADR-0008 constraint ("must sit behind the existing seam pattern"), and decide where per-tx hook *registration* lives (almost certainly the ALS store → couples to G4). `TxLogger` stays what it is; this is a new seam, not a widening of `warn`.

- **G2 — `TransactionAborted{cause: unknown}` erases the structured DB error. (High · BENDS · unblocks Retry, "Do Now")**
  Decide how to carry a structured SQLSTATE/error-class through the rollback boundary *without* importing `pg` into core (the same constraint `isPoolTimeoutError` already respects structurally). Retry classification (40001/40P01) and OTel error attributes both need it.

- **G3 — Adapter capability is one boolean + a separate assembly denylist. (Medium · BENDS · unblocks Multi-driver)**
  `supportsIndependentTransactions` (runtime, in the adapter) and `NON_INTERACTIVE_ENTITY_KINDS` (assembly-time, in `driver-capability.ts`) are two capability notions in two places. Decide a **unified per-mode capability descriptor** (REQUIRES_NEW, NESTED/savepoint, sync-rollback bridge) so the port can express "REQUIRES_NEW yes / savepoints no" and gate features per adapter.

- **G4 — ALS store carries only `{client}`. (Medium · BENDS · unblocks OTel depth/mode + Replica routing)**
  Decide what metadata the store should carry (savepoint depth, propagation mode, access-mode, per-tx hook registry). Couples tightly to G1. Keep the "presence == active" invariant (ADR-0006 decision B) intact.

- **G5 — `#newTransaction` / `#nested` are near-duplicate boundary shells. (Low-med · cheap in-place fix / `wayfinder:task`)**
  Extract one `#runInBoundary(wrap, work)` so retry (G2) and lifecycle hooks (G1) attach in one place, not two. Small, decision-free — a candidate in-place fix, but sequence it *after* G1/G2 decide the boundary shape so it isn't extracted twice.

- **G6 — `TransactionContext` has no suspend/exit. (Low · BENDS · unblocks SUPPORTS/NOT_SUPPORTED, "Explore" tier)**
  Note-only for now: the full-propagation-set "Explore" work will need an ALS `exit`/suspend and a `TxPlan` `run-bare` variant. Not pressing; the near-term propagation slice (MANDATORY/NEVER) doesn't touch it.

## Affirmations (things that are right — resist changing them)

- ADR-0006 purity boundary is real; the pure/effect split is a strength to preserve.
- The single deep `TransactionAdapter` port is correct — **do not** shatter it into shallow ports.
- `TxPlan` is correctly designed as the additive, compile-checked propagation seam.
- The transactional-client proxy is the correct, load-bearing seam for the outbox producer and safe-mode — the outbox "atomic for free" claim (ADR-0008) rests on it and it holds.
- `TransactionContext` is a clean deep ALS module; extend its *payload* (G4), not its shape.
