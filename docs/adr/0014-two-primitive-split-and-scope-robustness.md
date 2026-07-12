# Two transaction primitives, split by propagation; the scope hardens against forgotten dispose

**Status: Accepted.** Ratifies the **callback vs. scope** primitive split (audit **E1** — the flagship's load-bearing question) and hardens the `await using` scope (**R5** connection-leak, **R6/E6** commit-failure reactability). Annotates [ADR-0001](0001-framework-agnostic-core-on-raw-async-local-storage.md) (`enterWith` forbidden) and [ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md) (flagship uses the callback form). Decided HITL (#30, grilling). Quality-map scope: this **ratifies and hardens existing primitives — it designs no new one.**

## Context

The engine ships **two** ways to run a transaction:

- **`withTransaction(work)`** — callback-style. The manager enters `TransactionContext.run(tx, …)` *inside* the adapter callback, so ALS is set and the injected `db` proxy **auto-joins** — **implicit propagation**, the library's central value proposition.
- **`begin()` / `await using`** — a block scope ([transaction-scope.ts](../../packages/core/src/transaction-scope.ts)). Ergonomically lovely, but it **cannot set ALS**: ALS needs a callback and a block scope has none, and [ADR-0001](0001-framework-agnostic-core-on-raw-async-local-storage.md) forbids `enterWith` (context leakage). So the injected proxy does **not** auto-join a scope — the consumer must thread `scope.tx` explicitly.

Three audit findings converge on these two primitives:

- **E1 (High, gates the flagship)** — the nicer API (`await using`) forfeits implicit propagation. The Next.js/tRPC adapters must pick a per-request/per-action primitive, and the tempting one undercuts the core value prop. Must be decided before the flagship is built.
- **R5 (Medium)** — the scope holds its pooled connection open via the gate until dispose. `await using` guarantees disposal; a bare `begin()` that is **never disposed pins the connection indefinitely** — no timeout, no finalizer backstop.
- **E6 (Low-med)** — a commit that fails at dispose can only be *logged*; the block-scoped path has no value channel to surface it.

## Decision

### E1 — Ratify the two-primitive split; no new primitive

**A block scope with implicit propagation is impossible** without `enterWith`, and `enterWith` stays **forbidden** ([ADR-0001](0001-framework-agnostic-core-on-raw-async-local-storage.md); confirmed here). We do **not** build a propagation-preserving scope variant. Instead we ratify and document the split **loudly**:

| Primitive | Propagation | ALS | Shape | Use when |
|---|---|---|---|---|
| **`withTransaction(work)`** | **implicit** (proxy auto-joins) | set inside the callback | callback | the default — request/action handlers, service methods, **the flagship** |
| **`begin()` / `await using`** | **explicit** (`scope.tx`, no auto-join) | **not** set | block scope | advanced / block-scoped code that wants explicit resource management and is willing to thread `scope.tx` |

**The flagship doesn't need the scope.** Every entry point it targets — Server Action, Route Handler, tRPC middleware — **is already a callback boundary** ([ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md)), so the adapters use `withTransaction` under the hood and inherit implicit propagation. `begin()`/`await using` remains the **explicit-`scope.tx` escape hatch**, not the flagship path. This is a documentation + positioning decision: the two primitives are *deliberately different*, and choosing `await using` means opting out of auto-join — stated prominently, not a gotcha.

### R5 — "Must dispose" invariant **+** an opt-in, generous gate timeout backstop

Two layers, primary and backstop:

1. **Primary defense — a load-bearing, documented invariant:** *use `await using`, never a bare `begin()`.* `await using` guarantees `Symbol.asyncDispose` runs on scope exit (commit/rollback + connection release), so the leak **cannot** occur on the sanctioned path. A bare `const scope = (await begin()).value` with manual disposal is an **advanced escape hatch** whose contract is "you MUST dispose it" — elevated to a first-class documented invariant, not a footnote.

2. **Backstop — an opt-in, generous gate timeout (default OFF):**
   - **Default OFF.** No timer is armed unless the caller sets one. Because `await using` already guarantees disposal, a default timer would only ever risk rolling back **legitimate long-held work** — the exact footgun to avoid. The invariant carries the weight; the timer backstops only the bare-`begin()` escape-hatch path where a caller knowingly takes manual control.
   - **Configured `disposeTimeoutMs`**, resolved per-`begin({ disposeTimeoutMs })` with an optional **manager-level default** (`new TransactionManager(adapter, { disposeTimeoutMs })`) as fallback — the same shape `logger`/options already flow. A finite value opts in; unset / `Infinity` = no backstop.
   - **On fire:** force the gate to resolve with the **default-deny `rollback`** outcome, releasing the connection, and emit a **loud** `logger.warn` naming the fix ("transaction scope not disposed within `N`ms — forced rollback; use `await using`"). It **never throws** (dispose is no-throw, ADR-0003). A late real dispose finds the scope already settled → idempotent; a normal dispose clears the timer so it can't fire spuriously.
   - **Framed as a leak-backstop, not a work deadline** — the docs say so explicitly. It exists to reclaim a *forgotten* connection, not to bound legitimate duration.

### E6 — Commit-failure reactability: docs-only, defer `scope.outcome`

A commit that fails at dispose stays **logged**, as today. We **document** the escape: *use `withTransaction` when you need to react to a commit failure* — the callback form surfaces it as a `Result<T, E | DrizzleTxError>` value. We **defer** building an awaitable `scope.outcome` failure channel on the scope; it is a new capability with no current consumer, and the callback form already covers the need. If demand appears, `scope.outcome` slots in behind the same scope object without breaking the API.

## Consequences

- **The flagship's primitive is settled** — `withTransaction` (implicit), decided before the build. E1's blocking question is closed; [ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md)'s "adapters use the callback boundary" is now backed by an explicit primitive-choice ADR.
- **The two primitives are documented as deliberately asymmetric** — callback = implicit auto-join, scope = explicit `scope.tx`. Choosing the scope is opting out of the core value prop, stated up front. (The scope's JSDoc already says this; the docs/README get the loud version.)
- **`enterWith` remains forbidden** — reaffirmed; no propagation-preserving scope is built.
- **R5 implementation is execution:** the `disposeTimeoutMs` plumbing (option on `begin`/manager, a timer armed after `started`, force-rollback-on-fire, timer-clear on normal dispose, idempotency) lands in `transaction-scope.ts` + `transaction-manager.ts`. Default-off means zero behavior change for every existing caller.
- **E6 defers cleanly** — no `scope.outcome` now; the docs point commit-failure-reactors to `withTransaction`.
- **CONTEXT.md** gains the two-primitive split as ubiquitous language (callback/implicit vs scope/explicit) when the docs land.

## Rejected alternatives

- **Build a propagation-preserving `await using` scope** (auto-join from a block scope). Rejected: requires `enterWith`, which ADR-0001 forbids for context-leakage; there is no callback for ALS `run()` to wrap. The flagship doesn't need it (its entry points are callbacks).
- **A default-on gate timeout.** Rejected: any default risks rolling back legitimate long-held work — the footgun the ticket names. `await using` already guarantees disposal, so the default-off backstop loses nothing on the sanctioned path.
- **A manager-only (not per-call) timeout.** Rejected: the timeout is inherently a per-scope concern; per-`begin()` gives call-site precision, with a manager default only as a convenience fallback.
- **Build `scope.outcome` now** (E6 awaitable failure channel). Rejected for this effort: new capability, no consumer, and `withTransaction` already surfaces commit failure as a `Result`. Deferred, not foreclosed.
