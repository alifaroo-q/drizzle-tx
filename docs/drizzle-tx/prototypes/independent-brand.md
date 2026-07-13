# Prototype + decision: `Independent<Result>` brand for REQUIRES_NEW (E3, #31)

> **Status: implemented** on `main` — `Independent`/`NonIndependent`/`settle` in [`packages/core/src/result.ts`](../../../packages/core/src/result.ts), poisoned `TransactionWork` in [`propagation-plan.ts`](../../../packages/core/src/propagation-plan.ts), branded `'REQUIRES_NEW'` overloads in [`transaction-manager.ts`](../../../packages/core/src/transaction-manager.ts); guardrails in [`independent-brand.test-d.ts`](../../../packages/core/test/types/independent-brand.test-d.ts). Plan: [`docs/plans/2026-07-13-independent-brand-and-export-surface.md`](../../plans/2026-07-13-independent-brand-and-export-surface.md). The record below is the original spike/decision.

Throwaway type-level spike confirming E3's fix. **Decision (HITL #31): adopt the type-level brand**, named `Independent<T,E>` with a `settle()` unwrap. Verified by a clean `tsc --noEmit --strict` pass (both `@ts-expect-error` directives used). Blocks #32 (E4) — that ticket must export the branded REQUIRES_NEW signature.

## The footgun (E3)

A `REQUIRES_NEW` inner already settled on its **own** connection; its `Result` is a *value describing what happened*. But `return inner` at the outer boundary re-interprets an `err` as the **outer's** rollback signal ([propagation.integration.test.ts](../../../packages/core/test/integration/propagation.integration.test.ts#L101)). Today's fix is the undocumented `return ok(inner)` wrap — compile-silent, easy to miss.

## Mechanism finding (why the obvious brand fails)

- **Mechanism A — classic intersection brand `Independent<R> = R & { [tag]: true }`: INSUFFICIENT.** A branded value is a *superset* of `Result`, so it stays assignable to plain `Result` — `return inner` compiles. Empirically confirmed (the probe assignment `const p: Result = indep` raised no error). You cannot block `Branded → Base` by *adding* properties; the classic brand blocks only the *other* direction (fabricating a brand from plain).
- **Mechanism B — poison the WORK BOUNDARY with a phantom optional-`never`: WORKS.** The work type accepts `Result<T,E> & { readonly [IND]?: never }`. A branded value carries `{ [IND]: true }`, and `true ⊄ never`, so returning an `Independent` is rejected — while `.ok`/`.value`/`.error` still read through (the brand *is* `Result & tag`).

## Final shape (adopted)

```ts
declare const IND: unique symbol;
/** A REQUIRES_NEW outcome that already settled on its own connection. Inspect directly
 *  (.ok/.value/.error); it CANNOT be returned as an outer Result — settle() it consciously. */
export type Independent<T, E> = Result<T, E> & { readonly [IND]: true };

/** Unwrap to a plain Result (runtime: identity cast, ZERO cost). Returning this at the outer
 *  boundary is the conscious opt-in that "inner err → outer rollback". */
export const settle = <T, E>(i: Independent<T, E>): Result<T, E> => i as Result<T, E>;

// TransactionWork's return gains the phantom so a branded value can't be returned as work output:
export type TransactionWork<T, E> = () => Promise<Result<T, E> & { readonly [IND]?: never }>;

// withTransaction overloads — the REQUIRES_NEW literal alone returns the brand:
withTransaction<T, E>(p: 'REQUIRES_NEW', work): Promise<Independent<T, E | DrizzleTxError>>;
// REQUIRED / NESTED / no-propagation overloads return plain Result<T, E | DrizzleTxError> (unchanged).
```

## Ergonomics (verified by the spike)

| Usage | Behavior |
|---|---|
| `inner.ok` / `inner.value` / `inner.error` | **direct, untaxed** — no unwrap needed to inspect |
| `return inner` (the footgun) | **compile error** ✓ |
| `if (inner.ok) return ok(...)` (inspect → decide outer) | ✓ |
| `return ok(inner)` (commit outer, surface inner as value) | ✓ (`outer.value` is `Independent`, still inspectable) |
| `return settle(inner)` (propagate inner outcome as outer's) | ✓ — the **guardrail-not-a-wall** conscious escape |
| REQUIRED / NESTED `return inner` | ✓ (plain Result; savepoint-in-outer semantics) |
| runtime cost | **zero** (phantom symbol never set; `settle` = identity) |

**The ticket's weak spots, resolved:**
- *"Confirm inspection isn't a tax."* — It's **not taxed at all**: `.ok`/`.value`/`.error` read directly. `settle()` is needed only to *return/propagate*, never to inspect.
- *"Guardrail, not a wall — a determined unwrap-then-return still compiles."* — Confirmed and **accepted**: `return settle(inner)` compiles; that's the conscious "I want inner err to roll the outer" choice. The brand blocks the *accidental* `return inner`, which is the whole goal.
- *Reject alt (ii) runtime `{settled}` discriminant* — rejected: the brand is ergonomic and zero-cost, so a runtime wrapper (allocation + `.outcome.ok` inspection tax) is unwarranted.

## The one real cost — diagnostic locality

Because the outer work is an un-annotated `async () => {...}`, TS infers its return type from `return inner` and then rejects the **arrow at the `withTransaction(...)` call site** — *not* at the `return inner` line. So the error message points at the outer call, not the offending return. Acceptable, but pairs with a **docs callout** (JSDoc on the REQUIRES_NEW overload + a propagation guide note) so the fix is discoverable from the message.

## The spike (reference; throwaway)

The spike was a throwaway file typechecked with `tsc --noEmit --strict --target ES2022` → **EXIT 0** with both `@ts-expect-error` directives consumed. Six cases: (1) `return inner` blocked, (2) untaxed inspection, (3) inspect→decide / `ok(inner)` surface / `settle` escape, (4) NESTED plain, (5) plain `ok/err` unaffected, (6) can't fabricate a brand. The essential shape is captured above; the file itself is intentionally not kept (deliberately contains compile-error cases). Re-run from the "Final shape" + case list to reproduce.
