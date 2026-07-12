# Audit 03 — Public-API ergonomics

**Ticket:** [#22](https://github.com/alifaroo-q/drizzle-tx/issues/22) (wayfinder:research) · **Map:** [#19](https://github.com/alifaroo-q/drizzle-tx/issues/19) · **Date:** 2026-07-12

**Scope reviewed:** the exported surface (`index.ts`, `createDrizzleTx`/`DrizzleTx`, `Result` + combinators, `DrizzleTxError`/`matchError`, `TransactionScope`, the transactional-client proxy), the type-level guardrails (`test/types/*.test-d.ts`), `CONTEXT.md` naming, the core README, and — as the one **real adapter-author consumer** — the nestjs `TransactionHost`/`@Transactional`. Skills: `codebase-design`, `typescript-expert`. Lens: *is this the base every framework adapter (Next.js/tRPC, decorator-less, per-request/per-action) can build on?*

**Verdict in one line:** The type-level foundation is genuinely strong — the `never`-channel inference preserves domain errors, the 4 `withTransaction` overloads survive `.bind`, and the guardrail `*.test-d.ts` set is real. The ergonomic gaps are about **composition and the adapter-author seam**, not correctness: the beautiful `await using` scope **loses the implicit propagation that is the library's whole point** (and it's the primitive the flagship must choose), the `Result` combinators are **sync-only in an async-first library**, and the one real adapter had to **hand-copy the overload set** to wrap `withTransaction`.

---

## Part 1 — Assembly (`createDrizzleTx` → `{ db, withTransaction, begin, isActive, manager }`)

- **Names largely conform to `CONTEXT.md`** — `db` = transactional client ✓, `getBaseClient` discipline held, propagation vocabulary intact. Good.
- **Naming drift `isActive` vs `isTransactionActive`.** The factory exposes `isActive`; the manager method is `isTransactionActive()`. One concept, two names across the two surfaces a consumer sees. → E7.
- **`manager` is an undocumented escape hatch.** The factory returns the full `TransactionManager`, so `tx.withTransaction === tx.manager.withTransaction` and `tx.manager.getTransactionClient()` is reachable. Useful for adapter-authors (nestjs wraps `manager`), but for an end-consumer it's surface redundancy with no "advanced / not-the-happy-path" signal. → E7.
- **Option key `drizzle` names the library, not the role** (`CONTEXT.md` calls it the *base client*). Reads fine (`drizzle: drizzle({...})`) but is a small role-vs-brand drift. → E7.
- **Assembly throws (`UnsupportedDriverError`), by deliberate ADR-0010 asymmetry.** JSDoc documents it; acceptable, but a consumer trained on the no-throw discipline may not wrap the factory. Note-only.

## Part 2 — `Result` DX

- **Strength: `ok`/`err` return `Result<T, never>`/`Result<never, E>`.** The `never` channel is load-bearing and *works* — the domain error survives alongside `DrizzleTxError` and does **not** collapse (proven by `create-drizzle-tx.test-d.ts`). Excellent inference. Affirm.
- **Gap: combinators are sync-only in an async-first library.** `map`/`mapErr`/`andThen`/`unwrapOr`/`match` are all synchronous, but every unit of work is `() => Promise<Result>`. Composing several async fallible steps forces `await`-then-nest; there is no `andThenAsync`/`mapAsync` and no `pipe`/`flow` to make even the sync chain readable (standalone functions nest inside-out: `andThen(map(r,f),g)`). This is the biggest everyday friction for a per-request handler. → **E2**.
- **`match` (Result) vs `matchError` (DrizzleTxError kinds)** are different tools one letter apart — mild confusion surface. → E7.
- **The `ok`/`err` discipline has one sharp edge** — the REQUIRES_NEW/nested footgun (below). → E3.

## Part 3 — `begin()` / `await using` scope

- **`commit()` opt-in / default-deny is the right safe default.** Affirm.
- **The scope loses implicit propagation — and it is the flagship's load-bearing primitive.** `withTransaction(work)` gives *implicit* propagation (the injected `db` proxy auto-joins) but is callback-style; `begin()`/`await using` gives a lovely block scope but **does not set ALS** (ADR-0001, `enterWith` forbidden), so repositories using the injected proxy will **not** auto-join — the consumer must thread `scope.tx` explicitly, forfeiting the library's central value proposition. The Next.js/tRPC adapters (the reason the base exists — roadmap Massive #1) must choose between these, and the ergonomically nicer one undercuts implicit propagation. **This decision should be made before the flagship is built.** → **E1 (High)**.
- **Commit failure is unreactable through `await using`.** A commit that fails at dispose is only *logged* — the pretty API has no value channel to surface it (`use withTransaction when you need that as a Result`). Real ergonomic hole for the block-scoped path. Overlaps Audit-02 R5. → E6.

## Part 4 — Diagnostics & docs

- **Error messages are actionable** — `UnsupportedDriverError` names the fix (switch to neon-serverless), the `@Transactional` non-method guard is clear, the ignored-options warning is specific. Affirm.
- **`TransactionAborted{cause: unknown}` is poor at the display/log site** — a `matchError` handler receives `{cause: unknown}` with no `.message` without casting. Reinforces **Audit-01 G2 / Audit-02 R3** from the DX angle.
- **JSDoc coverage on load-bearing modules is rich and accurate** (assembly, scope, proxy, adapters). `errors.ts` factories and `result.ts` combinators are thinner but adequate. Affirm.

## Part 5 — TypeScript DX & the adapter-author seam

- **Strong: the 4 overloads survive `.bind`, and `DrizzleTx` indexes its member types off `TransactionManager['withTransaction']`** so the factory surface can't drift from the engine. Proven by `create-drizzle-tx.test-d.ts`. Affirm.
- **Strong guardrail set:** `matchError` exhaustiveness (+ negative `@ts-expect-error`), `TxPlan` exhaustiveness, overload preservation, domain-error non-collapse, ADR-0005 `@Transactional` direction guard (nestjs). Affirm.
- **Gap: adapter-authors must hand-copy the overload set to wrap `withTransaction`.** The one real consumer — nestjs `TransactionHost` — **re-declares all 4 overloads** and forwards through an `as (...args: unknown[]) => …` cast. Next/tRPC/Hono adapters will each copy this again. There is no exported call-signature type (e.g. a reusable `WithTransaction<TClient>`) an adapter can `extends`/reference. This is the highest-leverage *adapter-author* ergonomic gap for "the base every adapter builds on." → **E4**.
- **Gap: the public export surface is broad and `export *`-based.** `index.ts` mixes explicit re-exports (assembly, adapter, manager) with `export *` from `errors`/`result`/`logger`/`options`/`propagation`. Consequences: (a) internal utilities leak — `assertNever` is public; (b) adding any export to those modules **silently widens the public contract**. Decide the deliberate surface (convert `export *` → explicit named exports; keep `assertNever` and the error *factory* functions either out or explicitly "advanced/adapter-author"). → **E5**.

---

## Gap-list — candidate decision-tickets (feed the synthesis step)

Ranked by roadmap urgency (the flagship adapter is the near-term trigger). Held un-ticketed pending synthesis; convergences noted.

- **E1 — The `await using` scope loses implicit propagation; decide the flagship's per-request/per-action primitive. (High · decision · gates the flagship)**
  `withTransaction` (implicit, callback) vs `begin()`/`await using` (block-scoped, explicit `scope.tx`). The nicer API forfeits the core value prop. Decide the intended Next.js Server-Action / tRPC pattern — and whether the scope needs a propagation-preserving variant — *before* building the flagship (Massive #1).

- **E2 — `Result` combinators are sync-only in an async-first library. (Medium · decision)**
  No `andThenAsync`/`mapAsync`, no `pipe`/`flow`. Decide whether to ship async combinators and/or a pipe helper (kept tree-shakable, type-only-dependency per ADR-0003/0006), or to document the sanctioned `await`-composition pattern as the answer.

- **E3 — The REQUIRES_NEW/nested "wrap inner in `ok()`" footgun is under-documented. (Medium · decision · lands from Audit-02)**
  The sharpest `ok`/`err` edge — returning an inner `err` directly rolls back the *outer* tx — lives only in test comments. Decide the remedy: README + JSDoc callout, or an API affordance that makes an inner result's independence explicit. (Audit-02 explicitly handed this to ergonomics.)

- **E4 — Adapter-authors must hand-copy the 4 `withTransaction` overloads + a cast. (Medium · decision · highest-leverage for "the base adapters build on")**
  Export a reusable call-signature type (or a thin wrapper helper) so Next/tRPC/Hono adapters reference the overload contract instead of re-declaring it (as nestjs `TransactionHost` had to).

- **E5 — Public export surface is broad, `export *`-based, and leaks internals. (Medium · decision + cheap fix)**
  `assertNever` is public; `export *` silently widens the contract on any module addition. Decide the deliberate surface: explicit named re-exports; classify error-factory functions and `assertNever` as internal vs. adapter-author API.

- **E6 — Scope commit-failure is unreactable via `await using`. (Low-med · decision · CONVERGES with Audit-02 R5)**
  The block-scoped path can only *log* a commit failure. Decide whether `await using` gets an opt-in failure channel (e.g. an awaitable `scope.outcome`) or stays "use `withTransaction` for that." Resolve with R5.

- **E7 — Naming/discoverability nits. (Low · cheap in-place fixes)**
  `isActive` vs `isTransactionActive`; option key `drizzle` vs the *base client* role; `manager` unlabeled as an advanced escape hatch; `match` vs `matchError` proximity. Doc/rename cleanups.

## Affirmations (things that are right)

- The `never`-channel `ok`/`err` inference is excellent and correctly preserves domain errors alongside `DrizzleTxError`.
- The 4 overloads survive `.bind`, and `DrizzleTx` indexing off the manager keeps the factory surface in lockstep with the engine.
- The type-level guardrail suite (exhaustiveness of `matchError`/`TxPlan`, overload preservation, domain-error non-collapse, the ADR-0005 decorator guard) is a genuine strength.
- Naming largely conforms to `CONTEXT.md`; the base-client / transactional-client / active-transaction discipline holds.
- JSDoc on the load-bearing modules is rich, and `UnsupportedDriverError`'s message is actionable.
