---
"@drizzle-tx/core": minor
---

Deliberate two-tier export surface (#32).

The barrel is now an enumerated Tier A (app-developer) / Tier B (adapter-author)
surface. New Tier B exports for adapter authors: the `WithTransaction<TClient>`
overload contract (incl. the `REQUIRES_NEW` `Independent` brand) and the
`TxFailureFields` factory parameter type.

BREAKING (pre-1.0 minor): `assertNever` is no longer exported from
`@drizzle-tx/core` — it was an internal helper. For `DrizzleTxError`
exhaustiveness use `matchError(err, handlers)` (a complete handler map is
compile-enforced), or a local `switch` in your own code.
