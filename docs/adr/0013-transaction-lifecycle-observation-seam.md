# The transaction lifecycle is observed through one named seam; the ALS store stays immutable

**Status: Accepted (names a seam + fixes invariants; the event API is deferred).** Resolves audit gaps **G1** (no lifecycle-observation seam) and **G4** (ALS store carries only `{client}`) from #20, folding in **G5** (sequence one `#runInBoundary` first). Scoped by the quality map (#19): this ADR **names the seam and fixes the invariants any future seam must honor — it does *not* design the event API.** The event surface (method names, hook timing, retry/savepoint events) is **deferred to the hooks/OTel PRD**, because those are new *capabilities* and capability design is out of scope for the quality bar. Decided HITL (#29, grilling).

## Context

The manager already *knows* the entire transaction lifecycle — it enters a boundary, and the `work` callback resolving means commit while a throw means rollback ([transaction-manager.ts:108](../../packages/core/src/transaction-manager.ts#L108), `#runBoundary` in `NoOpDrizzleAdapter`). But it exposes **no seam to observe it**. `TxLogger` is `warn(string)` — a narrow warning sink, *not* an event seam (ADR-0006 keeps it deliberately shallow).

Two "Do Now" roadmap features **break** on this one missing thing (audit headline, #20):

- **Post-commit hooks** (`afterCommit`/`afterRollback`) — nowhere to attach.
- **OTel span-per-tx** — same missing seam, *plus* it wants savepoint-depth, propagation-mode, and retry-count, none of which the ALS store (`{ readonly client }`) or `TransactionContext` tracks (G4).

The load-bearing tension: ADR-0006 decision B made the store **immutable** — `{ readonly client }`, constructed once inside the adapter callback, no `setClient`, "presence == active". Any lifecycle machinery must *not* regress that. The removed in-place `client` mutation was "the subtlest thing in the codebase"; a mutable per-tx hook collection living inside the store would reintroduce exactly that class of footgun.

## Decision

### 1. There is ONE named extension point: the **transaction lifecycle observation seam**

Hooks, OTel, and retry-instrumentation all attach **here** — none invents its own seam. This ADR reserves the *name and role*; it lands **no code**. The method surface (what events fire, with what payload, when) is the hooks/OTel PRD's job.

- **Injected logger-style**, per the existing seam pattern ([ADR-0008](0008-transactional-outbox-poll-first-cdc-later.md): new surfaces sit behind the established injection pattern, not bolted onto the main API). Concretely: a constructor option on `TransactionManager` (like `logger`), optional, defaulted to a no-op — the same shape `TxLogger` already uses.
- **`TxLogger` is not widened.** It stays a warning sink. The observation seam is a *new, separate* injection — not a `warn` overload. (A lifecycle event is not a log line; conflating them was the mistake G1 names.)

### 2. Registration model: the named seam is a **manager-level observer**; per-tx registration is deferred

The named seam is **one observer injected at assembly**, firing lifecycle events (begin / commit / rollback, and later retry / savepoint-enter-exit) for **every** transaction. This is:

- **Fully immutable** — the observer is fixed at construction, held beside the adapter/logger, never mutated per-transaction. It needs **no tx-identity** and touches the ALS store not at all.
- **Sufficient for the breaking features' core** — OTel span-per-tx and coarse observation hooks are inherently manager-level (one instrument, every tx). Naming *this* unblocks the audit headline without any mutable state.

**Per-transaction registration** — the Spring-style `afterCommit(() => …)` registered *inside* a method body, scoped to *that* transaction — is a **separate, deferred capability** (hooks/OTel PRD), not part of this ADR's named seam. When it is designed, it is **bound by the invariant in §3**: its registry lives **beside** the store, **keyed by tx-identity**, never as a mutable collection inside the immutable store.

### 3. Store-mutability invariant (the load-bearing decision)

The ALS store **stays immutable** — ADR-0006 decision B holds unconditionally:

- `ActiveTx<TClient>` remains constructed-once with **`readonly` fields only**. "Presence == active"; there is no setter, no in-place reassignment, no `active` flag.
- **A future per-tx hook registry lives *beside* the store, keyed by tx-identity — never inside it.** Why beside-not-inside: a `REQUIRES_NEW` independent inner runs its own boundary on its own connection, and a `NESTED` savepoint runs within the parent; a mutable hook list *inside* the store would force each nested/independent transaction to either inherit or clobber its parent's registry, and would resurrect the in-place-mutation footgun ADR-0006 deleted. A registry keyed by tx-identity keeps each transaction's hooks separate while the store stays a pure immutable value.
- **Read-only metadata (G4) is *sanctioned in shape but added now in nothing*.** If the store later carries `depth` / `mode` / `access-mode` for OTel or replica-routing, those MUST be **`readonly` fields** (immutable, set at construction) — **never** a mutable collection. This ADR adds **no fields**: there is no consumer today and OTel/replica-routing are out of scope for the quality map. It fixes the *constraint* (readonly-only), not the fields.

> ⚠️ **Deferred, not decided — the tx-identity key.** *What* identifies a transaction (the client reference? a generated id?) is **not defined here** — there is no tx-id in the store today. Defining it is part of the deferred event API (hooks PRD), because only a per-tx-registration feature needs it (the manager-level observer of §2 does not). This ADR asserts the *shape of the constraint* — "beside the store, keyed by identity, store stays immutable" — and explicitly leaves the identity mechanism open.

### 4. Sequence G5 first — extract one `#runInBoundary`

Before any seam emits, extract the duplicate boundary shells `#newTransaction` / `#nested` ([transaction-manager.ts](../../packages/core/src/transaction-manager.ts)) into **one** `#runInBoundary(wrap, work)`. Both are today near-identical (try → `adapter.wrap` → `#ctx.run(toThrowable(await work()))` → `ok`; catch → `classifyRollback`). Extracting first means the future observer fires — and the ADR-0012 error-model / retry loop attaches — from **one** place, not two. G5 is a decision-free in-place refactor (execution; a `wayfinder:task`), sequenced *after* this ADR and ADR-0012 fix the boundary shape so it isn't extracted twice.

## Consequences

- **Nothing ships from this ADR now.** It reserves a name, fixes invariants, and sequences G5 — a *decision* artifact, per the map's plan-don't-do mode. Zero runtime change.
- **The immutable store is now a documented, load-bearing invariant** for all lifecycle work, not just an ADR-0006 refactor detail: hooks/OTel/retry must attach without mutating it.
- **The hooks/OTel PRD inherits a fixed frame:** one injected observer seam (manager-level, immutable); per-tx hooks via a beside-the-store identity-keyed registry; store metadata readonly-only; a defined tx-identity as its first task. It designs *within* these, not around them.
- **G5 is queued to execution** (after ADR-0012 impl) as the one-boundary extraction; it is where the observer and the retry loop will both attach.
- **CONTEXT.md** gains the term "lifecycle observation seam" when the PRD gives it a concrete surface — not now (avoids naming an unbuilt API).

## Rejected alternatives

- **Design the event API here** (method names, payloads, hook timing). Rejected: that is new-capability design (hooks/OTel), out of scope for the quality map. This ADR is the *frame* those features build inside; naming their methods now would pre-empt the PRD and likely drift.
- **Widen `TxLogger` into the event seam** (add lifecycle methods to it). Rejected: a lifecycle event is not a warning; overloading the warning sink is exactly the conflation G1 identifies. Separate injection.
- **Put a mutable per-tx hook registry inside the ALS store.** Rejected: reintroduces the in-place mutation ADR-0006 deleted, and breaks cleanly for nested/`REQUIRES_NEW` (whose hooks would inherit/clobber the parent's). Beside-the-store, keyed by identity, instead.
- **Define the tx-identity key now.** Rejected: only per-tx registration needs it, and that is deferred; inventing an identity mechanism with no consumer is speculative. Constraint asserted, mechanism deferred.
- **Add `readonly depth`/`mode` to the store as a down-payment.** Rejected *for this effort*: no reader exists and OTel/replica-routing are out of scope; the ADR sanctions the readonly shape so the down-payment is a safe, additive execution step whenever a consumer lands.
- **Reserve an empty `TransactionObserver` interface in code now.** Rejected: API-design-lite that the PRD would likely rework — mild drift for no benefit under plan-don't-do. Name lives in the ADR until the PRD gives it methods.
