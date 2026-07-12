# `Result` is the core / adapter-author contract; app-dev edges bridge to host-native or opt into Result-native

**Status: Accepted.** Locks the **Result-contract boundary** (Synthesis [#25](https://github.com/alifaroo-q/drizzle-tx/issues/25) Question 0) and **annotates the *scope* of [ADR-0003](0003-explicit-result-pattern-no-throw.md)** — it does not supersede it. ADR-0003 says *core never throws for modeled conditions*; this ADR says *who is obligated to speak `Result`, and who is bridged out of it*. It also folds in two rider decisions the synthesis attached here: **E2** (Result composition — docs-only) and **Q2** (`setRollbackOnly` — rejected). Grounded on the real production backend `Billy-s-Garage-BE`.

## Context

Five audits (#20–#24) kept circling one root tension: **rollback is welded to the return value** (`err` *is* the rollback signal, [ADR-0003](0003-explicit-result-pattern-no-throw.md)), and that welding is the source of the sharpest edges — the REQUIRES_NEW "wrap inner in `ok()`" footgun (E3), the absent `setRollbackOnly` analogue (Q2), the painful sync-only combinators (E2). Meanwhile the ecosystem is throw-shaped: *no* JS peer (typeorm-transactional, nestjs-cls, MikroORM, both Drizzle peers, Spring) uses `Result`, the flagship Next/tRPC audience is throw-native, and [ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md) already needs a **`Result`↔throw bridge** at the framework edge — the tell.

So the question the synthesis had to lock first, because E1/E2/E3/Q2 all inherit their meaning from it: **is `Result` the *consumer-facing* contract, or the *core / adapter-author* contract with throw-native app-dev edges?**

The evidence that settled it is `Billy-s-Garage-BE`, a real NestJS Postgres backend that is [ADR-0003](0003-explicit-result-pattern-no-throw.md) *in the wild*:

- Services return `Promise<Result<T, TypedError>>` — **687 `fail(...)` sites, 416 `success(...)` sites, 404 `isFailure` checks**. The Result-at-the-service-layer discipline is real, load-bearing, and lived-in.
- Controllers are the sole throw boundary: they unwrap with a `ts-pattern` `match` and `throw` the appropriate `HttpException`.
- It built a suite of **40 Result combinators and uses 0 of them** — every call site is `await` + `if (isFailure) return`. The composition machinery was written and then not adopted.

That backend is not a violation of the model to be corrected — it is proof the Result-native service layer is a *deliberate, viable surface* for authors who choose typed errors. It grandfathers NestJS in.

## Decision

### 1. `Result` is the **core + adapter-author** contract — not an every-consumer tax

`Result<T, E>` remains the contract wherever it earns its keep and is already enforced:

- **Core engine + the seam** — `withTransaction`/`begin` return `Result<T, E | DrizzleTxError>`; the `TransactionAdapter` port, the `TxPlan` decisions, the exhaustive `DrizzleTxError` union, and the `assertNever` completeness checks ([ADR-0005](0005-typed-decorator-forces-drizzletxerror.md), [ADR-0006](0006-functional-core-imperative-shell.md)) all speak `Result`.
- **Adapter authors** — anyone writing a `TransactionAdapter` or a framework adapter works in `Result` internally; it is their contract with core.

This is where `Result` is a genuine differentiator (zero-dependency, exhaustive, no thrown surprises on the correctness path). **Do not remove it.** E1/E2/E3/Q2 are re-scoped from *every-consumer* concerns to *adapter-author* concerns.

### 2. Each app-developer edge is **one of two things** — and the bridge is never imposed

At the app-developer surface, an edge is **either**:

- **(a) Bridged to the host's native convention** by the adapter — the app dev never touches raw `Result`. Per [ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md)'s split bridge: **tRPC → `throw TRPCError`** (driven by `next().ok`, no throw from us for domain errors); **Server Action → return `Result`** (a plain serializable object that keeps typed errors across the RSC boundary). The convention *matches the host*, chosen for least-surprise on that surface.

- **(b) A deliberately-chosen Result-native surface**, where the framework's own channel is throw-only and the author *opted into* typed errors: the **NestJS service layer** (grandfathered — controllers `match`→throw at the boundary, [ADR-0003](0003-explicit-result-pattern-no-throw.md)) and **raw `withTransaction`/`begin`** used directly. Here the author eats the `Result` surface by choice, because they value the exhaustive typed-error discipline.

**The bridge is never imposed.** There is no "you must convert to throw" or "you must convert to `Result`" mandate. The adapter for a host offers the host-native convention (a); an author who wants typed errors reaches for a Result-native surface (b). The asymmetry between surfaces ([ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md): tRPC throws, Server Actions return) is *intentional*, not a leak.

Net effect the synthesis wanted:

- The flagship adapters **don't charge the throw-native Next/tRPC audience a `Result` adoption tax**.
- E3's `ok()`-wrapping footgun **disappears for app developers** — they `throw` (or return via the bridge); only adapter-authors touch raw `Result` and its rollback-signal semantics.

### Rider E2 (Result composition) — **docs-only, no machinery**

We ship **no combinator suite and no generator-based do-notation** for `Result`. The sanctioned composition pattern is plain control flow:

```ts
const a = await stepOne();
if (isFailure(a)) return a;      // faithful early-return; err() rolls back
const b = await stepTwo(a.value);
if (isFailure(b)) return b;
// ...
```

The evidence is decisive: `Billy-s-Garage-BE` **built 40 combinators and uses 0** — real authors reach for `await` + `if (isFailure) return`, not `.andThen`/`.map` chains or generator do-notation.

**Be honest about the cost.** This is verbose, and the verbosity is an **accepted cost of the Result-native surface (b)**, not a solved problem. The escape valve — the throw-native app-dev edge (a) where you write ordinary `try`/`throw` — is a **flagship/future** deliverable ([ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md)). So **today the NestJS service author eats the verbosity**: they are on surface (b) and the bridge that would relieve them is not yet shipped. We state this plainly in the docs; we do not imply combinators make it ergonomic (they were tried and abandoned) nor that the throw-edge already rescues it (it doesn't, yet).

### Rider Q2 (`setRollbackOnly` / mark-for-rollback) — **rejected, out of scope**

Spring's `setRollbackOnly()` marks the current transaction for rollback without unwinding the call stack. We do **not** ship it. Why not / what instead:

- **Why not.** It requires **hidden mutable transaction state** — a flag set on an ambient tx that the commit path later reads. That fights [ADR-0003](0003-explicit-result-pattern-no-throw.md)'s explicit, value-based control flow (rollback should be a *returned* `err`, not a side-effect on hidden state) **and** [ADR-0006](0006-functional-core-imperative-shell.md)'s immutable ALS store (the store is built once at `TransactionContext.run(...)`; "presence == active", there is no in-place mutation and no `active`/`rollbackOnly` flag to toggle). Adding it would reintroduce exactly the implicit control flow the model exists to remove.
- **What instead.** The sanctioned rollback lever is **`return err(...)`** — explicit, typed, faithfully returned. For the "an inner `REQUIRES_NEW` failed but the outer should decide independently" case that `setRollbackOnly` is often reached for, the **`Independent<Result>` brand** ([#31](https://github.com/alifaroo-q/drizzle-tx/issues/31), E3) keeps an independent inner from over-rolling the outer at the type level.
- **Ecosystem check.** No JS peer ships mark-for-rollback; it is Spring-only. Absent it, we are not below the peer bar (Audit #24 confirmed core at/above peers almost everywhere).

## Consequences

- **ADR-0003's scope is now explicit**, not implicit: `Result` binds *core + adapter-authors*; app-dev edges are governed by [ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md)'s per-host bridge or are a chosen Result-native surface. ADR-0003 gets a one-line pointer here.
- **The NestJS service layer is grandfathered** as a Result-native surface (b), not a deviation. Its `Result`-return + controller-`match`→throw convention stands as the reference example.
- **No combinator/generator API is added** to `@drizzle-tx/core`'s public surface. Composition is documented as `await` + `if (isFailure) return`, with the verbosity called out as an accepted, not-yet-relieved cost.
- **`setRollbackOnly` is out of scope** for this effort (recorded on the map's Out-of-scope). It could only return if the effort is redrawn — and even then would have to reconcile with ADR-0003/0006.
- Nothing here changes runtime behavior; it fixes *meaning*. It gates how E2/E3/Q2 and the flagship adapters ([ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md)) are scoped and documented.

## Rejected alternatives

- **Result all-the-way as a deliberate identity choice** (make every consumer, including flagship Next/tRPC app devs, speak `Result`). Rejected: it charges the throw-native ecosystem a `Result` adoption tax on the very surface ([ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md)) we built the split bridge to avoid, and keeps E3's footgun in every consumer's face. The `Result` win is kept where it is enforced and earned (core + adapter-authors), not spent taxing app devs.
- **Ship the 40-combinator suite / generator do-notation to make (b) ergonomic.** Rejected on direct evidence: the reference backend built exactly this and used none of it. Machinery nobody adopts is surface area to maintain, not ergonomics.
- **Add `setRollbackOnly`.** Rejected — see Rider Q2.

## Evidence

`Billy-s-Garage-BE` (real production NestJS + Postgres backend, examined 2026-07-12): services return `Promise<Result<T, TypedError>>` — 687 `fail` / 416 `success` / 404 `isFailure` sites; controllers unwrap via `ts-pattern` `match` → throw `HttpException`; 40 hand-written `Result` combinators, 0 call sites. Grounds the Result-native-surface grandfathering (§2b), the E2 docs-only decision, and the "verbosity is an accepted cost" honesty. Ecosystem throw-shape and the per-host bridge: [ADR-0009](0009-framework-adapters-node-only-and-result-throw-bridge.md), Audit #24.
