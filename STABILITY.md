# Stability & Support Policy (pre-1.0)

`@drizzle-tx/*` is **pre-1.0**. It is used and tested, but the public surface is still
being hardened toward a stable `1.0`. This document states what that means for you.

## Semver, pre-1.0

While the version is `0.x`:

- **A minor bump (`0.x.0`) may contain breaking changes.** Under semver, `0.x` has no
  compatibility guarantee across minors — we use the minor slot the way `1.0`+ uses the major.
- **Patch bumps (`0.x.y`) are non-breaking** — fixes and additive changes only.
- Every breaking change ships with a **changeset** and a `CHANGELOG.md` entry describing the
  break and the migration. Read the changelog before bumping a minor.

Pin an exact or tilde range (`~0.x.y`) if you need to review each minor before adopting it.

## What's covered

| Surface | Stability |
|---|---|
| `@drizzle-tx/core` **Tier A** (app-developer API) | Committed surface — breaks only via a documented changeset. |
| `@drizzle-tx/core` **Tier B** (adapter-author API: `TransactionManager`, `TransactionAdapter`, `WithTransaction`, `DrizzleAdapter`, error factories) | Committed surface — same guarantee; aimed at adapter authors. |
| `@drizzle-tx/core/testing` (`NoOpDrizzleAdapter`, `FaultInjectingDrizzleAdapter`, error-shape helpers) | Stable, but **test-only** — not for production code paths. |
| `@drizzle-tx/nestjs` | Tracks core; the NestJS module + `@Transactional` + `TransactionHost` are the committed surface. |
| Anything not exported from a package entry point | **Internal** — no guarantee; may change in any release. |

The two published tiers are enumerated deliberately in `packages/core/src/index.ts` (Tier A / Tier B
section comments) — if a symbol isn't exported there (or from `@drizzle-tx/nestjs`), treat it as internal.

## Breaking-change process

1. A changeset (`pnpm changeset`) records the bump and a human-readable description.
2. CI opens/updates a "Version Packages" PR; merging it publishes and writes `CHANGELOG.md`.
3. Breaking changes are called out in the changelog entry with the migration path.

## Support floor

- **Node.js ≥ 22.13** — the supported runtime floor. (The `begin()` scope API relies on
  `await using` / `Symbol.asyncDispose`, available since Node 20.4, but the tested/supported
  floor is Node 22.13.) CI runs the suite on Node 22 and 24.
- **Dual ESM + CJS.** Both module systems are supported and checked (`publint` + `attw`) on every release.
- **PostgreSQL** via node-postgres / neon-serverless (interactive-transaction-capable drivers). See the
  driver matrix in the `@drizzle-tx/core` README.
