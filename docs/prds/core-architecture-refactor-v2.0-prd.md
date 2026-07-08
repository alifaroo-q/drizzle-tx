# `@drizzle-tx/core` Architecture Refactor (Functional Core / Imperative Shell) — Product Requirements Document (PRD)

> Internal architecture refactor of `@drizzle-tx/core`. No new end-user feature. Goal: crisp modularity, a pure functional core (propagation decisions, error translation) separated from a thin imperative shell (ALS mutation, adapter I/O, logging), with immutability on the hot path and side effects quarantined where they are genuinely needed.

**This is a v2 change** — the internal `TransactionAdapter` port and core's module layout may change. The public engine API (`TransactionManager.withTransaction`, `.begin`, `.getTransactionClient`, `.isTransactionActive`, the `Result`/`DrizzleTxError` model, `createTransactionalClient`, `DrizzleAdapter`) stays behavior-compatible; any deviation is called out explicitly under **Flagged Decisions**.

---

## Requirements Description

### Background

- **Business Problem**: The core engine works and is well-tested, but its logic is concentrated in one 290-line module, [`transaction-manager.ts`](../../packages/core/src/transaction-manager.ts), that tangles **pure decisions** (propagation switch, argument normalization, throw↔`Result` translation) with **effects** (ALS mutation, adapter calls, logging). The consequences today:
  - The propagation decision can only be exercised through a full fake-adapter + ALS round-trip, so the *decision* is tested through *timing/machinery*. Bugs in "which strategy for this mode+state" hide behind async plumbing.
  - The engine's central mutable state — the ALS store's `client` field is **reassigned in place** via a `setClient` callback threaded through the adapter interface ([transaction-manager.ts:235-237](../../packages/core/src/transaction-manager.ts#L235-L237), [:258-260](../../packages/core/src/transaction-manager.ts#L258-L260)) — is the subtlest thing in the codebase and leaks into the adapter's public shape.
  - The `err → throw RollbackSignal → catch → Result` round-trip spans 5 files, with the `PoolTimeoutError` type *deliberately duplicated* to dodge a `pg` import.
  - The `begin()` scope bridge (~50 lines of promise-gate/race machinery) is an orthogonal, genuinely-effectful concern crammed into the same class.
- **What breaks if unsolved**: Nothing at runtime — this is a *maintainability and testability* investment, not a bug fix. Honest YAGNI framing: the payoff is (a) fast pure unit tests with no Docker/ALS, (b) removal of the in-place mutation footgun, (c) an AI-/human-navigable module map where one concept lives in one place. If those aren't valued, this refactor should not be done.
- **Target Users**: Maintainers of `@drizzle-tx` (primarily the author) and future framework-adapter authors, who benefit from a smaller, purer core surface to reason about and extend (Hono/Express/Fastify adapters, additional propagation modes).
- **Value Proposition**: A **functional core / imperative shell** core: pure modules decide *what* should happen and return plain data; a thin shell *does* it. Validated by research (Bernhardt "Boundaries"; Ousterhout deep modules; Node's own `run()`-over-`enterWith()` guidance; keep the hand-rolled `Result`, do **not** adopt Effect-TS).

### Feature Overview

- **Core Features (this refactor)** — four candidates, each independently shippable:
  1. **Propagation Planner** (pure) — `planTransaction(inputs) → TxPlan` plus pure argument normalization.
  2. **TransactionContext** (deep effect module) — encapsulate ALS; eliminate the `setClient` in-place mutation.
  3. **Rollback/Error Boundary** (pure) — consolidate the throw↔`Result` translation into one module.
  4. **Scope Bridge** (effect module) — extract `begin()` / `TransactionScope` and its gate machinery.
- **Feature Boundaries (explicitly OUT of scope)**:
  - **No new propagation modes, no lifecycle hooks, no named connections, no sync-driver path.** This refactor only re-shapes existing behavior; it must not smuggle in new features (those remain their own PRDs).
  - **No error-library migration.** Keep the in-house `Result` + `DrizzleTxError`. Effect-TS / neverthrow / fp-ts are explicitly rejected (see Design Decisions).
  - **No change to `@drizzle-tx/nestjs` public API.** nestjs consumes only `TransactionManager`'s public methods and constructs core's `DrizzleAdapter`; it must keep compiling unchanged except for the mechanical adapter-construction call if the port changes.
  - **No change to the tsdown/dual-build, `erasableSyntaxOnly`, or ESNext.Disposable constraints.**
- **User Scenarios (maintainer-facing)**:
  1. A maintainer adds a propagation mode: they add a `TxPlan` variant + a `planTransaction` branch and get compile errors at every non-exhaustive `switch` — no ALS or DB needed to test the decision.
  2. A maintainer debugs a rollback-classification edge case: they unit-test `classifyRollback(thrownValue)` directly as a pure table.
  3. A framework-adapter author implements `TransactionAdapter` without ever seeing a `setClient` mutation callback — the port hands them the tx client as a value.

### Detailed Requirements

- **Input/Output** — see **Interface Design** per candidate below. Every fallible path continues to return `Result<T, E | DrizzleTxError>`; the only internal `throw` remains the rollback signal, caught at the same boundary.
- **Data Requirements**: The ALS store becomes an immutable `{ readonly client }` (see Flagged Decision B). All boundary values (`TxPlan`, `DrizzleTxError`, `Result`) are `readonly` discriminated unions matched with `assertNever`.
- **Edge Cases (must be preserved exactly)**:
  - `REQUIRED` + active → join (no BEGIN); `REQUIRED` + inactive → new root.
  - `REQUIRES_NEW` while active but adapter not pool-backed → `err(NotPoolBacked)` (now a `reject` plan, not an inline early-return).
  - `NESTED` + active → savepoint; `NESTED` + inactive → new root.
  - Options on join/nested → stripped + one warning logged (now a pure decision carried in the plan; shell performs the log).
  - `err(...)` from work rolls back the whole tx; `PoolTimeoutError` maps to `PoolConnectionTimeout`; any other throw maps to `TransactionAborted`.
  - `begin()` scope: default-deny rollback on dispose; `commit()` opt-in; early-start-failure surfaced as `err`; dispose never throws (settle failure logged).

---

## Design Decisions

### Technical Approach

- **Architecture Choice: Functional Core / Imperative Shell over a "big class with private helpers."**
  - *Chosen*: split `transaction-manager.ts` into pure modules (`propagation-plan.ts`, `rollback-boundary.ts`) + effect modules (`transaction-context.ts`, `transaction-scope.ts`) + a thin `transaction-manager.ts` coordinator that wires them. The core *decides and returns values*; the shell *interprets and performs effects*.
  - *Simpler option rejected — "just extract private methods / leave as-is"*: the current file already uses private methods, but they still close over `#als`/`#adapter`/`#logger`, so they are not independently testable and the mutation still leaks through the port. Extraction-without-purity does not move the testability needle; rejected.
  - *More-complex option rejected — adopt an effect system (Effect-TS) or a Result library (neverthrow/fp-ts)*: research is decisive — Effect imposes its runtime + DI on every downstream consumer of a *library's* public API; neverthrow is reportedly stalling; fp-ts is superseded. The value they add (combinators) is already implemented in [`result.ts`](../../packages/core/src/result.ts). Rejected — keep the zero-dependency in-house `Result`.
- **Guardrail (Ousterhout): keep ONE deep `TransactionAdapter` port.** Do **not** shatter it into `Connector` + `SavepointManager` + `Committer` pass-through interfaces. The Drizzle/`pg` ugliness (rc.4 construction, structural `isPoolBacked`, CJS/ESM `instanceof`) stays hidden behind the single adapter.
- **Guardrail (Node/ALS): the pure core never calls `getStore()`.** The shell reads ALS **once**, snapshots it into a plain `{ active: boolean }` value, and passes that into `planTransaction`. `run()`-only is preserved (ADR-0001); `enterWith` remains forbidden.

### Key Components (target module map)

Pure leaves unchanged: `result.ts`, `errors.ts`, `options.ts`, `propagation.ts`, `logger.ts`, `transactional-client.ts`.

| Module | Kind | Owns | Candidate |
| --- | --- | --- | --- |
| `propagation-plan.ts` | **pure** | `TxPlan` union, `planTransaction`, `normalizeArgs` | 1 |
| `transaction-context.ts` | **effect (deep)** | ALS lifecycle, immutable store, `run()`-only rule | 2 |
| `adapter.ts` (port) | interface | tx/savepoint seam — **`setClient` removed** | 2 |
| `drizzle-adapter.ts` | effect | Drizzle/`pg` impl updated to new port | 2 |
| `rollback-boundary.ts` | **pure** | `RollbackSignal`, `toThrowable`, `classifyRollback`, `isPoolTimeoutError` | 3 |
| `transaction-scope.ts` | **effect** | `TransactionScope`, `openScope` gate bridge | 4 |
| `transaction-manager.ts` | **shell** | wire context+adapter+logger; interpret `TxPlan`; expose public API | all |

### Interface Design

#### Candidate 1 — Propagation Planner (`propagation-plan.ts`, pure; in-process)

```ts
/** A plain-data description of what to do — the core decides, the shell interprets. */
export type TxPlan =
  | { readonly kind: 'join';     readonly ignoredOptions?: TxOptions }   // REQUIRED + active
  | { readonly kind: 'new-root'; readonly options?: TxOptions }          // begin a top-level tx
  | { readonly kind: 'nested';   readonly ignoredOptions?: TxOptions }   // savepoint
  | { readonly kind: 'reject';   readonly error: DrizzleTxError };       // e.g. NotPoolBacked

export interface PropagationInputs {
  readonly propagation: Propagation;
  readonly active: boolean;                        // snapshot of ALS state (NOT the live store)
  readonly supportsIndependentTransactions: boolean;
  readonly options?: TxOptions;
}

/** Pure. Exhaustive switch + assertNever. No ALS, no adapter, no I/O. */
export function planTransaction(inputs: PropagationInputs): TxPlan;

/** Pure. Collapses the withTransaction overloads into a normalized triple. */
export function normalizeArgs<T, E>(
  a: Propagation | TxOptions | TransactionWork<T, E>,
  b?: TxOptions | TransactionWork<T, E>,
  c?: TransactionWork<T, E>,
): { readonly propagation: Propagation; readonly options?: TxOptions; readonly work: TransactionWork<T, E> };
```

- **Hides**: the propagation truth-table and the overload-resolution rules.
- **Shell usage**: `const plan = planTransaction({ propagation, active: ctx.isActive(), supportsIndependentTransactions, options })` then `switch (plan.kind)`.
- **Trade-off**: one extra indirection (decide → interpret) in exchange for a decision that is a pure `(input) → output` unit test.

#### Candidate 2 — TransactionContext (`transaction-context.ts`, effect/deep; in-process)

```ts
/** The immutable ALS payload. Presence in the store == "a transaction is active". */
interface ActiveTx<TClient> { readonly client: TClient; }

export class TransactionContext<TClient> {
  current(): TClient | undefined;                  // getStore()?.client
  isActive(): boolean;                             // getStore() !== undefined
  /** run()-only (ADR-0001). Establishes an IMMUTABLE store for the callback's async scope. */
  run<T>(client: TClient, fn: () => Promise<T>): Promise<T>;
}
```

**The cornerstone change** — the adapter port loses `setClient`; ALS is entered *inside* the adapter callback once the real tx client exists, so the store is constructed immutable:

```ts
// adapter.ts (port) — BEFORE:  wrapWithTransaction(options, setClient, work)
//                     AFTER:
export interface TransactionAdapter<TClient> {
  getBaseClient(): TClient;
  readonly supportsIndependentTransactions: boolean;
  wrapWithTransaction<T>(options: TxOptions | undefined, work: (tx: TClient) => Promise<T>): Promise<T>;
  wrapWithNestedTransaction<T>(parent: TClient, work: (sp: TClient) => Promise<T>): Promise<T>;
}

// shell (transaction-manager.ts) — no mutation, immutable store from the start:
const value = await this.#adapter.wrapWithTransaction(options, (tx) =>
  this.#ctx.run(tx, () => this.#runWork(work)),
);
```

- **Hides**: `AsyncLocalStorage`, the `run()`-only / no-`enterWith` rule, the store shape.
- **Removes**: the in-place `ctx.client = client` mutation **and** the `setClient` parameter from every adapter method.
- **Dependency category**: **In-process** (ALS is in-memory) — merged and tested directly.
- **Trade-off**: v2 port change; requires updating core's `DrizzleAdapter` + the fake adapters in core tests (nestjs is unaffected — it doesn't implement the port).

#### Candidate 3 — Rollback/Error Boundary (`rollback-boundary.ts`, pure; in-process)

```ts
/** Internal sentinel carrying the consumer error E through Drizzle's throw-to-rollback path. */
export class RollbackSignal<E> { readonly payload: E; constructor(payload: E); }

/** err → throw the signal; ok → the value. (The one place the no-throw rule is inverted.) */
export function toThrowable<T, E>(result: Result<T, E>): T;

/** Classify a caught throw at the tx boundary into a Result error. Pure, exhaustive. */
export function classifyRollback<E>(e: unknown): Result<never, E | DrizzleTxError>;
//   RollbackSignal → err(payload) | PoolTimeoutError → err(PoolConnectionTimeout) | else → err(TransactionAborted)

/** Structural guard (constructor-name), kept here so core still never imports pg. */
export function isPoolTimeoutError(e: unknown): e is { readonly timeoutMs: number | undefined };
```

- **Hides**: the entire throw↔`Result` translation and the pg-avoidance duplication (`PoolTimeoutLike` lives here, once).
- **Shell usage**: `try { const v = await adapter.wrap(..., () => toThrowable(await work())); return ok(v); } catch (e) { return classifyRollback(e); }`
- **Trade-off**: none material — this is pure consolidation of already-pure logic into one testable place.

#### Candidate 4 — Scope Bridge (`transaction-scope.ts`, effect; local-substitutable)

```ts
export interface TransactionScope<TClient> extends AsyncDisposable {
  readonly tx: TClient;
  commit(): void;
  rollback(): void;
}

/** Bridge a callback-scoped transaction runner to a block-scoped `await using` handle.
 *  `runInTx` is the shell's "new transaction" primitive; it yields the tx client to `use`. */
export function openScope<TClient>(
  runInTx: (use: (tx: TClient) => Promise<Result<void, symbol>>) => Promise<Result<void, DrizzleTxError>>,
  logger: TxLogger,
): Promise<Result<TransactionScope<TClient>, DrizzleTxError>>;
```

- **Hides**: the `gate`/`started`/`Promise.race` machinery, the `SCOPE_ROLLBACK` sentinel, default-deny outcome, and dispose-never-throws logging.
- **Dependency category**: **Local-substitutable** — tested against a fake `runInTx`/adapter, no DB required for the lifecycle logic.
- **Trade-off**: highest-risk extraction (subtle async timing). Its existing Postgres integration test ([transaction-scope.integration.test.ts](../../packages/core/src/transaction-scope.integration.test.ts)) is the safety net and stays green throughout.

### Flagged Decisions (structural changes surfaced for explicit opt-in)

Per the agreed "structural + note fixes" contract, these are behavior-neutral changes the refactor *enables*; each is opt-in and can be rejected without blocking the others:

- **Decision A — Remove `setClient` from the adapter port (Candidate 2).** Cleaner port, no mutation. Cost: v2 break to any external `TransactionAdapter` implementer (none known outside core). **Recommend: accept.**
- **Decision B — Drop the `active: boolean` field from the ALS store; use store-presence as "active" (Candidate 2).** Removes a redundant field that could theoretically disagree with presence. **Recommend: accept.**
- **Decision C — Move the "options ignored on join/nested" *decision* into the pure planner** (carried as `ignoredOptions`); the shell performs the `logger.warn`. Same observable warning, but the decision becomes pure-testable. **Recommend: accept.**
- **Non-goal**: no behavior change to *when* a warning fires, *which* error maps to *which* variant, or *any* commit/rollback timing. If implementation surfaces a genuine latent bug, stop and raise it as its own decision — do not fold a fix in silently.

### Constraints

- **Compatibility**: `@drizzle-tx/nestjs` must build and pass unchanged (except the mechanical `new DrizzleAdapter(...)`/`new TransactionManager(...)` call site, which is already in core's control). Public core exports keep their signatures. tsdown dual ESM+CJS build, `erasableSyntaxOnly` (no parameter properties), and `ESNext.Disposable` lib requirement all preserved.
- **Performance**: no new allocations on the hot path beyond a single small `TxPlan` object per `withTransaction` call (negligible; replaces inline branching). Immutability via `readonly` + `as const` on the hot path; `Object.freeze` **not** used per-operation.
- **Security**: none specific.
- **Scalability**: the `TxPlan` union is the documented seam for future propagation modes (`SUPPORTS`/`MANDATORY`/…) — additive, compile-checked.

### Risk Assessment

- **Technical Risks**:
  - *Inverting ALS entry (enter inside the adapter callback) subtly changes context visibility.* Mitigation: the nested path already reads the parent client *before* entering; verify via the full existing integration suite (propagation + scope) that `getTransactionClient()` returns identical values at every point. This is the one change to review hardest.
  - *Scope bridge timing regressions (Candidate 4).* Mitigation: extract last; keep its integration test untouched as the oracle; do a pure lifecycle unit test for commit/rollback/early-failure/dispose.
- **Dependency Risks**: none added — the refactor *removes* coupling (setClient) and adds no runtime deps.
- **Schedule Risks**: candidates are independently shippable; if time-boxed, ship 1 and 3 (pure, low-risk, high test payoff) first and defer 2 and 4.

---

## Acceptance Criteria

### Functional Acceptance

- [ ] `planTransaction` covers all `Propagation` × `active` × `supportsIndependentTransactions` combinations with pure unit tests; a missing `TxPlan` case is a compile error.
- [ ] `normalizeArgs` resolves all four `withTransaction` overload shapes, unit-tested purely.
- [ ] `classifyRollback` maps `RollbackSignal` / `PoolTimeoutError` / arbitrary throw to the correct `Result` error, unit-tested purely.
- [ ] `TransactionContext` establishes an immutable store; no code path reassigns the store's `client`. The `setClient` parameter is gone from `TransactionAdapter`.
- [ ] `openScope` reproduces every current `begin()`/scope behavior (default-deny rollback, `commit()`, early-start-failure `err`, dispose-never-throws).
- [ ] The full existing integration suite (`propagation.integration`, `transaction-scope.integration`, `drizzle-adapter.integration`) passes **unchanged**.
- [ ] `@drizzle-tx/nestjs` builds and its tests pass with no source changes.

### Quality Standards

- [ ] Test Coverage: new pure unit suites for `propagation-plan`, `rollback-boundary`; boundary test for `transaction-context`; lifecycle test for `transaction-scope`. Old shallow tests that only exercised inlined logic via the fake adapter are **deleted, not layered** (replace, don't stack).
- [ ] `pnpm build && pnpm typecheck && pnpm test` green; `pnpm -r run check:publish` (`publint`/`attw`) clean.
- [ ] Type-level tests (`*.test-d.ts`) for `DrizzleTxError`/`matchError` exhaustiveness still pass; add one asserting `TxPlan` exhaustiveness.

### User (maintainer) Acceptance

- [ ] `transaction-manager.ts` shrinks to a thin coordinator (target: well under half its current 290 lines) with no pure logic inlined.
- [ ] Documentation: update `CLAUDE.md` "gotchas" (remove the `setClient`/in-place-mutation note; add the FC/IS module map) and `CONTEXT.md` if terminology shifts. Add ADR-0006 "Functional core / imperative shell split; adapter port drops setClient."

---

## Execution Phases

### Phase 1: Preparation
**Goal**: Lock behavior before moving it.
- [ ] Confirm the existing integration suite is green as the behavioral oracle.
- [ ] Write ADR-0006 capturing the FC/IS decision + Flagged Decisions A/B/C.
- **Deliverables**: green baseline, ADR-0006 draft.
- **Estimate**: 0.5 day.

### Phase 2: Pure core (Candidates 1 & 3) — lowest risk
**Goal**: Extract purity with zero effect changes.
- [ ] `propagation-plan.ts` (`TxPlan`, `planTransaction`, `normalizeArgs`) + pure tests; shell interprets the plan.
- [ ] `rollback-boundary.ts` (`RollbackSignal`, `toThrowable`, `classifyRollback`, `isPoolTimeoutError`) + pure tests; shell uses it.
- **Deliverables**: two pure modules, shell wired, old inlined-logic tests deleted.
- **Estimate**: 1–1.5 days.

### Phase 3: Context (Candidate 2) — the cornerstone
**Goal**: Encapsulate ALS; remove `setClient` + in-place mutation.
- [ ] `transaction-context.ts`; change `adapter.ts` port; update `drizzle-adapter.ts` + fake test adapters; invert ALS entry into the adapter callback.
- [ ] Boundary tests for `TransactionContext`; full integration suite must stay green (hardest review point).
- **Deliverables**: mutation-free context, simplified port.
- **Estimate**: 1.5 days.

### Phase 4: Scope (Candidate 4) — highest risk, extract last
**Goal**: Isolate the imperative scope bridge.
- [ ] `transaction-scope.ts` (`TransactionScope`, `openScope`); `begin()` becomes a thin shell delegation.
- [ ] Lifecycle unit tests; keep `transaction-scope.integration.test.ts` untouched as oracle.
- **Deliverables**: standalone scope module, slim `transaction-manager.ts`.
- **Estimate**: 1 day.

### Phase 5: Integration & docs
**Goal**: Land the reshaped core.
- [ ] Full `build`/`typecheck`/`test`/`check:publish`; update `CLAUDE.md` + `CONTEXT.md`; finalize ADR-0006.
- **Deliverables**: green tree, updated docs.
- **Estimate**: 0.5 day.

---

**Document Version**: 2.0
**Created**: 2026-07-08
**Out of Scope**: new propagation modes, lifecycle hooks, named connections, sync-driver path, any error-library migration, any `@drizzle-tx/nestjs` public-API change.
**Sequencing note**: Candidates are independently shippable in the order 1+3 → 2 → 4 (ascending risk). If time-boxed, 1+3 alone capture most of the testability payoff.
