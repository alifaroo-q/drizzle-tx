# Explicit Result pattern — the library never throws for modeled conditions

`@drizzle-tx/*` uses an explicit `Result<T, E>` pattern throughout. Fallible operations return `ok(value)` or `err(error)`; the engine does **not** throw for modeled conditions. The only `throw` in the whole flow is an internal signal used to trigger a Drizzle rollback, caught at the same boundary and converted back to a `Result` — so no throw escapes the engine. All error variants are modeled as an exhaustive discriminated union and matched with `assertNever` for compile-time completeness.

## Why

The user's codebases standardize on the Result pattern with exhaustive, type-enforced error handling and no implicit control flow via exceptions. A transaction library sits on the critical correctness path, so making every failure an explicit, matchable value (rather than a thrown surprise) is a first-class requirement, not a stylistic preference.

## Key decisions

- **Thin in-house `Result`** — no external dependency (not `neverthrow`). A library that exposed a third-party Result in its public API would force that dependency and its types on every consumer. We ship a minimal `{ ok: true; value } | { ok: false; error }` plus `ok()/err()/assertNever()` from `@drizzle-tx/core`.
- **Rollback via `err`.** Drizzle rolls back only when its transaction callback throws, so the engine translates a returned `err` (or an unexpected throw) into that single internal throw, then returns the `err`. `err` is therefore a first-class rollback signal — Result-style code rolls back without ever throwing. The user's own `err(e)` is returned faithfully; only *infrastructure* failures use our `DrizzleTxError` union (`PoolConnectionTimeout`, `TransactionAborted`, `HostNotInitialized`, `NotPoolBacked`).
- **`@Transactional` returns a `Result` and never throws** (strict model). `ok` commits; `err` rolls back and is returned; an unexpected throw becomes `err(TransactionAborted{cause})`. **Controllers are the sole throw boundary** — they unwrap the `Result` and, on `err`, exhaustively match and throw the appropriate `HttpException`. This is the one place a throw is explicitly needed (NestJS exception filters map exceptions to HTTP responses).

## Considered / rejected

- **Throw-transparent decorator** (re-throw the user's error so Nest filters catch it directly): more idiomatic for conventional NestJS, but reintroduces implicit throw-based control flow into the service layer. Rejected in favor of the strict "controllers unwrap and match" model.
- **`neverthrow`**: ergonomic and dual-format, but couples every consumer to it via our public API. Rejected for a published library.

## Consequences

- Every core public signature returns `Result`; adding a `DrizzleTxError` variant is a breaking-but-compile-caught change at every `switch`/`assertNever` site.
- Consumers must adopt the Result-at-the-service-layer, throw-at-the-controller convention; the docs ship a worked controller example.
