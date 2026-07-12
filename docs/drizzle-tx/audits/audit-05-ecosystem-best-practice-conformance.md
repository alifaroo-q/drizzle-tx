# Audit 05 — Ecosystem best-practice conformance

**Ticket:** [#24](https://github.com/alifaroo-q/drizzle-tx/issues/24) (wayfinder:research) · **Map:** [#19](https://github.com/alifaroo-q/drizzle-tx/issues/19) · **Date:** 2026-07-12

**Method:** local measurement (publint `--strict` + attw on both packages; `package.json` distribution fields) + a triangulated web-research pass (skill: `web-research`) against the peer bar — nestjs-cls `@Transactional`/transactional-adapters, Spring `@Transactional`, typeorm-transactional, MikroORM, herenickname/drizzle-transactional, nickdeis/drizzle-transaction-context. Sources ranked first-party > write-up > blog, every claim ≥2 sources or flagged single-source; verified 2026-07-12.

**Verdict in one line:** On **quality** dimensions this core is **at or above the peer bar almost everywhere** — its packaging/distribution hygiene is **best-in-class for the category** (no surveyed peer matches it), its optional-peer seam matches the *better* peers, its REQUIRES_NEW pool discipline **leads**, and its no-op testing adapter is at **direct parity with the closest prior art**. Only **three** real gaps surface, all small: an over-aggressive Node floor, no mark-for-rollback affordance, and no written stability policy. This audit **validates** the quality bar more than it expands it.

---

## Measured locally (this run)

- **publint `--strict`: "All good!"** for `@drizzle-tx/core` **and** `@drizzle-tx/nestjs`.
- **attw: all-green** (node10 / node16-from-CJS / node16-from-ESM / bundler) across **every** entrypoint — `@drizzle-tx/core`, `/core/testing`, `@drizzle-tx/nestjs`, `/nestjs/testing`.
- core: `type: module`, **`sideEffects: false`**, dual ESM+CJS, `exports` with **`types` first** per condition, drizzle-orm **optional peer**, `engines.node >=22.13`.
- nestjs: `type: commonjs`, `tsc`-built, all peers correct. (Minor: no `sideEffects` field — immaterial for a CJS decorator package.)

## Peer bar (triangulated web-research — key facts)

| Dimension | Peer reality | Us |
|---|---|---|
| **npm provenance** | **None** of 5 peers publishes with provenance (`dist.attestations` absent) [T1 registry] | **OIDC provenance + attestation** (CLAUDE.md) — **ahead of all** |
| **`exports` hygiene** | Both Drizzle peers put **`types` LAST** + a **single types file** for import+require — the attw-flagged masquerading shape [T1 registry] | `types`-first, per-condition `.d.ts`/`.d.cts`, attw-clean — **ahead** |
| **ESM+CJS** | typeorm-transactional, nestjs-cls adapters are **CJS-only**; only the 2 Drizzle peers are dual [T1 registry] | Correct dual (core) — **at/above bar** |
| **Node engines floor** | All peers **`>=18`** (one `>=12`); none `>=20`/`>=22` [T1 registry] | **`>=22.13` — more aggressive than every peer** → Q1 |
| **Optional-peer seam** | Best peers (nestjs-cls, nickdeis) inject ORM as a **peer via adapter/token**; herenickname **hard-deps** drizzle-orm+reflect-metadata+zod [T1 registries/READMEs] | Optional peer, zero required deps — **matches the better peers, beats herenickname** |
| **REQUIRES_NEW pool-exhaustion** | Real, acknowledged upstream (Spring #26250, drizzle #1473); **no JS peer documents/warns/times-out** [T1 fetches] | ADR-0002 timeout→`err(PoolConnectionTimeout)` + docs — **leads** |
| **No-op / mock test adapter** | nestjs-cls ships **`NoOpTransactionalAdapter`** [T1 docs] | ADR-0007 observable no-op — **direct parity** |
| **Rollback-only (mark-for-rollback)** | Spring first-class `setRollbackOnly()`; **no JS peer** exposes it [T1 Spring docs] | No analogue → Q2 (Spring-only, not a JS norm) |
| **Per-tx isolation levels** | Table-stakes in every peer [T1 each] | `TxOptions.isolationLevel/accessMode/deferrable`, forwarded + tested — **met** |
| **Written semver/stability policy** | **None** of the peers publishes one; leader typeorm-transactional stale since 2023-10 [T1 registry] | None yet → Q3 (no peer norm, but a cheap lead for a depended-on seam) |
| **Default-propagation clarity** | MikroORM has a **split default** (`em.transactional`→NESTED vs `@Transactional`→REQUIRED) — a docs-clarity trap [T1 docs] | Consistent REQUIRED default — **no trap** |

*Roadmap-excluded (peers ship, but on our roadmap — not gaps here):* lifecycle hooks (typeorm-transactional, drizzle-transactional), full 7-mode propagation set (nestjs-cls, MikroORM), rollback-per-test `runInTransaction` helper (TypeORM lineage; nestjs-cls deliberately skips it → our roadmap Gem "withRollback"), Spring `rollbackFor`/`noRollbackFor` overrides.

---

## Gap-list — candidate tickets (adopt / adopt-later / reject)

Only three genuine gaps; all small. Held un-ticketed pending synthesis.

- **Q1 — Node `engines` floor `>=22.13` is more aggressive than every peer and excludes Node 20 LTS. (ADOPT · cheap in-place fix + verify)**
  Every peer floors at `>=18`; Node 20 is the mainstream 2025 floor (require-esm was backported to 20.x). The library's *actual* runtime needs are `Symbol.asyncDispose` (Node ≥ 20.4, per CLAUDE.md) and real dual CJS (not require-ESM, so 22.12 isn't required). For "the base every adapter builds on" — where Next.js/serverless deployments frequently run Node 20 — a `>=22.13` floor needlessly shrinks reach. **Decide: lower to the true floor (~Node 20.4 LTS) or document a concrete reason 22.13 is required.** Verify `await using`/dual-build behavior on Node 20 before dropping.

- **Q2 — No mark-for-rollback ("rollback-only") affordance. (ADOPT-LATER · design note · resolve with Audit-03 E3)**
  Spring's `setRollbackOnly()` lets a *joined inner* that returns normally still poison the *outer* transaction. In the `Result` model, a joined inner returning `ok` cannot force the outer to roll back — the only lever is returning `err`, which is exactly the REQUIRES_NEW/nested "wrap inner in `ok()`" footgun (E3). **No JS peer ships rollback-only either**, so this is a Spring-reference gap, not a JS-norm miss — but it gives the E3 decision a concrete design target. Decide whether a `setRollbackOnly`-style affordance belongs, alongside E3. Not urgent.

- **Q3 — No documented pre-1.0 stability / semver policy. (ADOPT · cheap in-place fix)**
  No peer publishes one — but the flagship Next/tRPC adapter will *depend on this core's seam*, and a short "what's stable, what may change before 1.0, 1.0 criteria" note is a low-cost lead that de-risks that dependency and signals seriousness the stale/policy-less peers lack. A README section or `STABILITY.md`.

## Affirmations (we meet or exceed the bar — preserve, don't fix)

- **Packaging/distribution is best-in-class for the category:** OIDC provenance (no peer has it), publint-`--strict`-clean + attw-all-green, `types`-first per-condition exports, `sideEffects: false`, correct dual ESM+CJS. **Do not add packaging decision-tickets** — this is a strength to keep.
- **Optional-peer seam** matches the better peers and beats the hard-dep anti-pattern.
- **REQUIRES_NEW pool discipline (ADR-0002) leads the field** — no JS peer warns or fast-fails.
- **No-op testing adapter (ADR-0007) is at parity with nestjs-cls `NoOpTransactionalAdapter`** — and shipping a *failure-injecting* variant (Audit-04 T4b) would be a lead, since **no peer** ships one.
- **Per-tx isolation levels are shipped and forwarded** — table-stakes, met.
- **Consistent REQUIRED default** avoids MikroORM's split-default docs trap.

## Cross-audit informing (this audit was chartered to inform #21/#22/#23)

- **Q2 sharpens Audit-03 E3** — the Spring `setRollbackOnly()` reference names the "right" affordance the REQUIRES_NEW/nested footgun lacks. Resolve E3 with Q2 in view.
- **Confirms Audit-04 T4** — the no-op adapter is the correct prior-art-parity move; and because *no peer* ships failure-injection, T4b would be category-leading, not catch-up.
- **Bounds the packaging surface** — the synthesis should treat distribution hygiene as *done/leading* and add no work there.
