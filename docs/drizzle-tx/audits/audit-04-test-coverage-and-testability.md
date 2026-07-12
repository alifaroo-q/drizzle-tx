# Audit 04 — Test coverage & testability

**Ticket:** [#23](https://github.com/alifaroo-q/drizzle-tx/issues/23) (wayfinder:research) · **Map:** [#19](https://github.com/alifaroo-q/drizzle-tx/issues/19) · **Date:** 2026-07-12

**Scope reviewed:** measured coverage (v8) across `core-unit` + `core-integration` and the nestjs projects; the full `packages/core/test/{unit,integration,types}` suite; the `/testing` `NoOpDrizzleAdapter`. Skills: `vitest-test-coverage`.

## Measured coverage (v8, this run)

| Project scope | Stmts | Branch | Funcs | Lines | Tests |
|---|---|---|---|---|---|
| `@drizzle-tx/core` `src` (unit + integration) | **99.31%** | **98.7%** | **100%** | **99.21%** | 105 |
| `@drizzle-tx/nestjs` `src` (unit + integration) | **100%** | **100%** | **100%** | **100%** | 29 |

**The only uncovered line in all of core is `propagation-plan.ts:52` — the `default: return assertNever(propagation)` exhaustiveness sink**, which is unreachable by design (a compile-time guard). Every other core file and all of nestjs are at 100% on all four metrics. **Line/branch coverage is, for practical purposes, complete.**

**Verdict in one line:** Coverage numbers are excellent and **testability is a genuine strength** — ADR-0006 delivered: every pure decision and both effect modules are exercisable with fakes, zero Docker. The real finding is a **paradox**: near-100% line coverage **masks missing *scenario* coverage** — the failure modes Audit-02 flagged traverse already-covered branches, so they read as "covered" while remaining untested — and the **single most important correctness property of an ALS library, concurrent-request isolation, has no test at all.**

---

## Part 1 — Coverage gaps

- **Line/branch: effectively none.** The lone gap (`assertNever` sink) is intentional dead code; chasing it would be theatre. Do **not** treat "get to 100%" as the goal here.
- **The paradox that matters:** high line coverage is giving **false scenario-confidence**. The `catch → classifyRollback` boundary in `#newTransaction`/`#nested` is *covered* (hit by the "unexpected throw" test), so v8 reports the branch green — but the distinct failure *scenarios* Audit-02 enumerated (COMMIT-fails-after-`ok`, ROLLBACK-fails-loses-`E`, savepoint create/release failure, connection-loss mid-tx) **all funnel through that same covered branch and none is individually asserted**. Coverage % cannot see the difference. → **T2** (absorbs Audit-02 **R6**).

## Part 2 — Testability (strong — affirm)

- **Every pure decision is unit-tested in isolation, no ALS/DB:** `planTransaction`, `normalizeArgs` (`propagation-plan.test.ts`), `classifyRollback`, `toThrowable` (`rollback-boundary.test.ts`). ADR-0006's central promise is real.
- **Both effect modules are fake-driven, no Docker:** `TransactionContext` tested with a plain fake client (`transaction-context.test.ts`, incl. nested shadow/restore); `openScope` tested with a fake `Runner` (`transaction-scope.test.ts`, incl. commit-fail warn + pre-capture errors).
- **The manager runs under two fakes** — a hand-rolled failing/counting adapter *and* the shipped `NoOpDrizzleAdapter` — so no behavior needs the real DB to be reached. The integration suite is a **behavioral oracle**, not the only path.
- **No behavior is reachable only through full machinery.** No testability gap found.

## Part 3 — Edge / property gaps

- **Concurrency: entirely untested — the headline gap.** The only `Promise.all` in the suite is pool teardown. **Nothing asserts that two concurrent requests don't cross-contaminate each other's transactional client** — the exact property `AsyncLocalStorage.run()` (over the forbidden `enterWith`) was chosen to guarantee (ADR-0001, "avoid context leakage"). Missing: concurrent `withTransaction` via `Promise.all` each seeing its own tx; concurrent `REQUIRES_NEW` drawing independent connections; concurrent `begin()` scopes. → **T1 (High)**.
- **Nesting is depth-1 only.** Every integration nesting test is outer + one inner. Propagation *compositions* at depth ≥2 (NESTED-in-NESTED, REQUIRES_NEW-in-NESTED, savepoint-within-savepoint) — real user patterns — are unexercised end-to-end. Each single decision is pure-tested; the composition is not. Low runtime risk, real behavior. → **T3**.
- **The propagation × active-state matrix is example-based but behavior-exhaustive.** `planTransaction.test.ts` enumerates all 8 behavior-distinct combos (the `supportsIndependent` axis only bites for REQUIRES_NEW+active, and both branches are tested). Complete — but as `it(...)` blocks, not `it.each`, so **adding a 4th propagation mode (roadmap) won't force a new matrix row**. → T5.
- **Dispose orderings** are well covered (no-commit, commit-then-dispose, rollback-after-commit, early-return) — but **double-dispose** and concurrent-scope orderings are not. → T1/T3.

## Part 4 — `/testing` subpath quality (`NoOpDrizzleAdapter`, ADR-0007)

- **Faithful at what it promises:** records `{kind, outcome}` in order, commit-on-success / rollback-on-throw, with `reset` — verified by `noop.test.ts`. The ADR-0007 boundary-assertion contract holds.
- **Footgun: it does not isolate or roll back data.** It runs `work` against the *same* client with no real transaction, so a consumer using it to assert "my rollback discarded the row" gets a **false pass**. The construction warning says "transactions disabled — testing only" but not "does **not** roll back data" — the limitation isn't surfaced where it would bite. → **T4a**.
- **No failure-injection in `/testing`.** There is no shipped adapter that fails BEGIN/COMMIT/savepoint on demand — every failure test hand-rolls its own fake. This is exactly the tooling needed to write the missing **T2** scenario tests (and Audit-02's R1/R2 tests) *without* Docker fault-injection. → **T4b**.
- Minor: NoOp hard-codes `supportsIndependentTransactions = true`, so it can't reproduce the `NotPoolBacked` reject path for a consumer test. Note-only.

---

## Gap-list — candidate tickets (mostly **task**/coverage; feed the synthesis step)

This axis yields more *task* tickets than *decision* tickets — expected for coverage work (the map's Notes allow task tickets + cheap fixes).

- **T1 — No concurrency / ALS-isolation tests. (High · task)**
  Add tests asserting concurrent requests don't cross-contaminate: parallel `withTransaction` (`Promise.all`) each seeing its own tx client; concurrent `REQUIRES_NEW`; concurrent `begin()` scopes; double-dispose. This is the library's core correctness property and is currently unasserted. (The *decision* embedded: whether these become a standing property-test suite — see T5.)

- **T2 — Line coverage masks untested failure scenarios. (High · task · absorbs Audit-02 R6)**
  COMMIT-fails-after-`ok`, ROLLBACK-fails-loses-`E`, savepoint create/release failure, connection-loss — all traverse the already-covered `catch → classify` branch and none is asserted. Write these scenario tests (gated on T4b tooling). Document that coverage % ≠ scenario confidence for this codebase.

- **T3 — Deep-nesting compositions untested. (Medium · task)**
  Exercise depth-≥2 propagation combinations end-to-end (NESTED-in-NESTED, REQUIRES_NEW-in-NESTED, savepoint-within-savepoint) against real Postgres.

- **T4 — `/testing` needs a failure-injecting adapter, and NoOp's data-non-isolation must be signalled. (Medium · decision + task · ENABLES T2 / Audit-02 R1,R2)**
  (a) Decide how to signal that `NoOpDrizzleAdapter` does not roll back data (sharpen the warning/JSDoc, or make the limitation structural) so it isn't misused for data-effect assertions. (b) Decide whether `/testing` ships a failure-injecting adapter (fail BEGIN/COMMIT/savepoint on demand) — the enabler for the T2 and Audit-02 scenario tests without Docker fault-injection.

- **T5 — No table/property tests; no coverage thresholds in CI. (Low-med · cheap fixes)**
  (a) Table-drive the propagation and dispose-ordering matrices (`it.each`) so a new propagation mode forces a new row. (b) Add a `coverage.thresholds` gate (~95%, below the ~99% baseline) so a coverage regression fails CI — currently there is none.

## Affirmations (things that are right)

- Core line/branch coverage is effectively complete (only the intentional `assertNever` sink is "uncovered"); nestjs is 100% on all four metrics.
- **ADR-0006's testability goal is fully delivered** — every pure decision and both effect modules are exercisable with fakes, zero Docker; the manager runs under both a fake adapter and NoOp.
- The propagation × active-state matrix, though example-based, enumerates every behavior-distinct combination.
- `NoOpDrizzleAdapter` faithfully records boundary kind+outcome in order with reset — the ADR-0007 contract holds for boundary assertions.
- The real-Postgres integration suite (db-per-worker) is a genuine behavioral oracle, not a coverage prop.
